// AI 분석 패널의 순수 로직: 전송 데이터 구성, 요청 본문, 응답 검증, 규칙 기반 대체 분석.
// 네트워크 호출(sendToAnthropic)만 브라우저 fetch를 사용하며, 테스트에서는 호출하지 않습니다.

import { t, getLang, fmtNumber } from './i18n.js';

export const AI_MODEL = 'claude-haiku-5-5';
export const AI_MAX_TOKENS = 700;
const MAX_REPLY_CHARS = 3000;
const MAX_POSITIONS = 30;

const LANG_NAME_KO = { ko: '한국어', en: '영어', ja: '일본어', es: '스페인어', zh: '중국어(간체)' };
// 시스템 지시는 한국 세법 맥락을 고정하려고 한국어로 두고, 답변 언어만 화면 언어에 맞춥니다.
const systemPrompt = () => [
  '당신은 한국 거주자의 해외주식 양도소득세 정리를 돕는 도우미입니다.',
  '사용자가 보낸 집계 숫자(JSON)만 근거로 답하세요. 숫자를 바꾸거나 없는 숫자를 만들지 마세요.',
  '세법을 해석해야 하는 부분(환율 기준, 수수료 처리, 3억 초과 구간 등)은 "세무사 확인 필요"라고 말하세요.',
  '답변은 한국어 평문으로 작성하고, 다음 순서를 지키세요: 1) 올해 상황 요약 2) 연말 전 실현 순서 제안 3) 주의점.',
  '표나 코드블록은 쓰지 마세요. 전체 600자 이내로 쓰세요.',
  `답변 언어는 ${LANG_NAME_KO[getLang()] || '한국어'}입니다. 제목 항목 번호는 1) 2) 3)을 그대로 쓰세요.`,
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
    system: systemPrompt(),
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
  if (!json || typeof json !== 'object') return { ok: false, error: t('aiBadShape') };
  if (!Array.isArray(json.content)) return { ok: false, error: t('aiNoContent') };
  const block = json.content.find((b) => b && b.type === 'text' && typeof b.text === 'string');
  if (!block) return { ok: false, error: t('aiNoText') };
  const text = block.text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, MAX_REPLY_CHARS);
  if (!text) return { ok: false, error: t('aiEmpty') };
  return { ok: true, text, error: null };
}

// 실제 호출. 사용자가 버튼을 눌렀을 때만 호출해야 합니다.
export async function sendToAnthropic({ key, payload, fetchImpl = globalThis.fetch, timeoutMs = 30000 }) {
  if (!isPlausibleKey(key)) return { ok: false, error: t('aiBadKey') };
  const req = buildRequest(key, payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: controller.signal });
    if (res.status === 401) return { ok: false, error: t('aiRejected') };
    if (res.status === 429) return { ok: false, error: t('aiRateLimit') };
    if (!res.ok) return { ok: false, error: t('aiHttp', { status: res.status }) };
    const json = await res.json();
    return parseReply(json);
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? t('aiTimeout') : t('aiNetwork');
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// 규칙 기반 대체 분석 (키가 없을 때). 같은 레이아웃에 줄 단위 문장을 넣습니다.
export function ruleBasedAnalysis({ summary, positions, realizedByTicker = {} }) {
  const won = (n) => t('wonAmt', { n: fmtNumber(Math.round(n)) });
  const lines = [];
  lines.push(
    t('ruleSummary', { year: summary.year, net: won(summary.net), base: won(summary.taxableBase), tax: won(summary.tax) }),
  );
  const losers = positions.filter((p) => p.unrealizedGainKRW !== null && p.unrealizedGainKRW < 0);
  const gainers = positions.filter((p) => p.unrealizedGainKRW !== null && p.unrealizedGainKRW >= 0);
  const unpriced = positions.filter((p) => p.unrealizedGainKRW === null);

  if (summary.taxableBase > 0) {
    lines.push(t('ruleLossFirst'));
    if (losers.length) {
      const names = losers
        .slice()
        .sort((a, b) => a.unrealizedGainKRW - b.unrealizedGainKRW)
        .map((p) => t('ruleName', { ticker: p.ticker, amt: won(p.unrealizedGainKRW) }));
      lines.push(t('ruleLossCand', { names: names.join(', ') }));
    } else {
      lines.push(t('ruleNoLoss'));
    }
  } else if (summary.headroom > 0) {
    lines.push(t('ruleHeadroom', { amt: won(summary.headroom) }));
    if (gainers.length) {
      const names = gainers
        .slice()
        .sort((a, b) => a.unrealizedGainKRW - b.unrealizedGainKRW)
        .map((p) => t('ruleName', { ticker: p.ticker, amt: won(p.unrealizedGainKRW) }));
      lines.push(t('ruleGainCand', { names: names.join(', ') }));
    }
  } else {
    lines.push(t('ruleNoHeadroom'));
  }

  if (unpriced.length) {
    lines.push(t('ruleUnpriced', { n: unpriced.length }));
  }
  const realizedCount = Object.values(realizedByTicker).filter((v) => v).length;
  if (realizedCount) {
    lines.push(t('ruleRealized'));
  }
  lines.push(t('ruleDisclaimer'));
  return lines.map((l) => l.slice(0, 280));
}
