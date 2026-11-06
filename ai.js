// AI 분석 패널의 순수 로직: 전송 데이터 구성, 요청 본문, 응답 검증, 규칙 기반 대체 분석.
// 네트워크 호출(sendToAnthropic)만 브라우저 fetch를 사용하며, 테스트에서는 호출하지 않습니다.

export const AI_MODEL = 'claude-haiku-5-5';
export const AI_MAX_TOKENS = 700;
const MAX_REPLY_CHARS = 3000;
const MAX_POSITIONS = 30;

const SYSTEM_PROMPT = [
  '당신은 한국 거주자의 해외주식 양도소득세 정리를 돕는 도우미입니다.',
  '사용자가 보낸 집계 숫자(JSON)만 근거로 답하세요. 숫자를 바꾸거나 없는 숫자를 만들지 마세요.',
  '세법을 해석해야 하는 부분(환율 기준, 수수료 처리, 3억 초과 구간 등)은 "세무사 확인 필요"라고 말하세요.',
  '답변은 한국어 평문으로 작성하고, 다음 순서를 지키세요: 1) 올해 상황 요약 2) 연말 전 실현 순서 제안 3) 주의점.',
  '표나 코드블록은 쓰지 마세요. 전체 600자 이내로 쓰세요.',
].join('\n');

const round = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null);

// 서버로 보내는 데이터: 연도 합계와 종목별 합계만 포함합니다. 날짜, 거래 ID, 로트 정보는 넣지 않습니다.
export function buildPayload({ summary, positions, fxNow, realizedByTicker = {} }) {
  return {
    taxYear: summary.year,
    fxRateKRWPerUSD: round(fxNow),
    summary: {
      totalGainKRW: round(summary.totalGain),
      totalLossKRW: round(summary.totalLoss),
      netKRW: round(summary.net),
      deductionKRW: round(summary.deduction),
      taxableBaseKRW: round(summary.taxableBase),
      tax: round(summary.tax),
      remainingHeadroomKRW: round(summary.headroom),
      saleCount: summary.saleCount,
    },
    positions: positions.slice(0, MAX_POSITIONS).map((p) => ({
      ticker: String(p.ticker).slice(0, 12),
      openQty: Math.round(p.qty * 1e6) / 1e6,
      costKRW: round(p.costKRW),
      unrealizedGainKRW: round(p.unrealizedGainKRW),
      realizedThisYearKRW: round(realizedByTicker[p.ticker] || 0),
    })),
  };
}

export function buildPrompt(payload) {
  return {
    system: SYSTEM_PROMPT,
    userText: '다음은 사용자의 집계 데이터(JSON)입니다.\n' + JSON.stringify(payload),
  };
}

export function buildRequest(key, payload) {
  const prompt = buildPrompt(payload);
  return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'content-type': 'application/json',
      'x-api-key': String(key).trim(),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: AI_MAX_TOKENS,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.userText }],
    }),
  };
}

// 키 형식만 확인합니다 (실제 유효성은 API 응답으로만 알 수 있음).
export function isPlausibleKey(key) {
  if (typeof key !== 'string') return false;
  return /^sk-ant-[A-Za-z0-9_-]{20,200}$/.test(key.trim());
}

// 응답 검증: text 블록만 사용하고, 제어문자를 지우고, 길이를 제한합니다.
export function parseReply(json) {
  if (!json || typeof json !== 'object') return { ok: false, error: '응답 형식이 올바르지 않습니다.' };
  if (!Array.isArray(json.content)) return { ok: false, error: '응답에 내용이 없습니다.' };
  const block = json.content.find((b) => b && b.type === 'text' && typeof b.text === 'string');
  if (!block) return { ok: false, error: '텍스트 응답이 없습니다.' };
  const text = block.text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, MAX_REPLY_CHARS);
  if (!text) return { ok: false, error: '빈 응답입니다.' };
  return { ok: true, text, error: null };
}

// 실제 호출. 사용자가 버튼을 눌렀을 때만 호출해야 합니다.
export async function sendToAnthropic({ key, payload, fetchImpl = globalThis.fetch, timeoutMs = 30000 }) {
  if (!isPlausibleKey(key)) return { ok: false, error: 'API 키 형식이 올바르지 않습니다.' };
  const req = buildRequest(key, payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: controller.signal });
    if (res.status === 401) return { ok: false, error: 'API 키가 거부되었습니다. 키를 확인하세요.' };
    if (res.status === 429) return { ok: false, error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' };
    if (!res.ok) return { ok: false, error: `요청이 실패했습니다 (HTTP ${res.status}).` };
    const json = await res.json();
    return parseReply(json);
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? '응답 시간이 초과되었습니다.' : '네트워크 오류로 요청하지 못했습니다.';
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// 규칙 기반 대체 분석 (키가 없을 때). 같은 레이아웃에 줄 단위 문장을 넣습니다.
export function ruleBasedAnalysis({ summary, positions, realizedByTicker = {} }) {
  const won = (n) => `${Math.round(n).toLocaleString('ko-KR')}원`;
  const lines = [];
  lines.push(
    `${summary.year}년 실현 순이익은 ${won(summary.net)}, 기본공제 250만원을 뺀 과세표준은 ${won(summary.taxableBase)}, 예상 세액은 ${won(summary.tax)}입니다.`,
  );
  const losers = positions.filter((p) => p.unrealizedGainKRW !== null && p.unrealizedGainKRW < 0);
  const gainers = positions.filter((p) => p.unrealizedGainKRW !== null && p.unrealizedGainKRW >= 0);
  const unpriced = positions.filter((p) => p.unrealizedGainKRW === null);

  if (summary.taxableBase > 0) {
    lines.push('과세표준이 남아 있으므로, 손실 종목을 먼저 정리해 올해 이익과 통산하는 방법을 검토할 만합니다.');
    if (losers.length) {
      const names = losers
        .slice()
        .sort((a, b) => a.unrealizedGainKRW - b.unrealizedGainKRW)
        .map((p) => `${p.ticker}(약 ${won(p.unrealizedGainKRW)})`);
      lines.push(`손실 후보: ${names.join(', ')}. 같은 종목은 선입선출로 오래된 lot부터 빠지므로 매도 수량을 맞춰 보세요.`);
    } else {
      lines.push('현재가를 입력한 종목 중 손실 상태인 종목이 없습니다. 손실 종목을 실현할 수 없다면 이익 실현으로 세금이 늘지 않도록 시뮬레이터에서 확인하세요.');
    }
  } else if (summary.headroom > 0) {
    lines.push(`올해 공제 여유는 약 ${won(summary.headroom)}입니다. 이 범위 안에서 이익을 실현하면 세금 없이 정리할 수 있습니다.`);
    if (gainers.length) {
      const names = gainers
        .slice()
        .sort((a, b) => a.unrealizedGainKRW - b.unrealizedGainKRW)
        .map((p) => `${p.ticker}(약 ${won(p.unrealizedGainKRW)})`);
      lines.push(`이익 후보는 작은 이익부터 보세요: ${names.join(', ')}. 시뮬레이터의 공제 활용 제안을 참고하세요.`);
    }
  } else {
    lines.push('공제 여유가 이미 없습니다. 추가 이익 실현은 세금을 늘리므로, 내년 이후 실현을 검토하는 것이 일반적입니다.');
  }

  if (unpriced.length) {
    lines.push(`현재가를 입력하지 않은 종목 ${unpriced.length}개는 분석에서 빠졌습니다.`);
  }
  const realizedCount = Object.values(realizedByTicker).filter((v) => v).length;
  if (realizedCount) {
    lines.push('일부 종목은 올해 이미 실현 손익이 있습니다. 같은 종목을 추가로 팔면 선입선출 순서가 바뀌므로 다시 계산하세요.');
  }
  lines.push('이 내용은 참고용입니다. 환율 기준과 수수료 처리는 세무사에게 확인하세요.');
  return lines.map((l) => l.slice(0, 280));
}
