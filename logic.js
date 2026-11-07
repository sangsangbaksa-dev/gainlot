// 순수 계산 로직 (DOM 없음). 화면은 app.js가 담당합니다. 사용자에게 보이는 문구는 i18n.js의 t()로 만듭니다.
// 신고용 CSV 열 이름과 가져오기 열 이름 목록은 국세청 양식·증권사 파일 형식이므로 한국어 원문을 유지합니다.
import { TAX_CONSTANTS, DEFAULT_OPTIONS } from './constants.js';
import { t as tl, fmtNumber } from './i18n.js';

const EPS = 1e-9;
const TICKER_RE = /^[A-Z0-9][A-Z0-9.\-^]{0,11}$/;
const NUM_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
const DAY_MS = 86400000;

// 계좌 이름을 비워 두면 이 이름을 씁니다. 계좌 구분 이전에 저장된 거래도 이 계좌로 들어갑니다.
export const DEFAULT_ACCOUNT = '기본 계좌'; // 저장 값(한국어 원문). 화면에는 accountLabel()로 번역해 보입니다.
export const accountLabel = (a) => (a === DEFAULT_ACCOUNT ? tl('defaultAccount') : a);
const ACCOUNT_MAX = 20;

// ---------- 공통 유틸 ----------

// 원 단위 반올림 (0.5는 0에서 멀어지는 쪽). 부동소수 오차 1e-6원 허용.
export function roundWon(x) {
  if (!Number.isFinite(x)) throw new TypeError('roundWon: 유한한 숫자가 아닙니다');
  const sign = x < 0 ? -1 : 1;
  const r = Math.round(Math.abs(x) + 1e-6);
  return r === 0 ? 0 : sign * r;
}

export function newId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return 't-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function isoToday(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 세율 적용 (원 미만 절사). 부동소수 오차를 줄이려고 1e-6 단위에서 먼저 반올림합니다.
export function computeTax(taxable, rate = TAX_CONSTANTS.totalRate) {
  if (!(taxable > 0)) return 0;
  return Math.floor(Math.round(taxable * rate * 1e6) / 1e6);
}

const accountOf = (t) => t.account || DEFAULT_ACCOUNT;
const lotKey = (account, ticker) => JSON.stringify([account, ticker]);

// ---------- 입력 검증 ----------

// 문자열 또는 숫자를 받아 숫자로 바꿉니다. 빈 값은 allowEmpty 여부에 따라 처리합니다.
export function parseNumber(raw, opts) {
  const { name, decimals, min, max, minExclusive = false, allowEmpty = false, example } = opts;
  const hint = example ? tl('exampleHint', { ex: example }) : '';
  let s;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { ok: false, error: tl('errNotNumber', { name }) };
    s = raw.toString();
    if (/e/i.test(s)) return { ok: false, error: tl('errRange', { name }) };
  } else if (raw === null || raw === undefined) {
    s = '';
  } else if (typeof raw === 'string') {
    // 천 단위 쉼표, 공백, $, ₩, 원, USD 표기는 떼어 냅니다.
    s = raw.trim().replace(/[,\s$₩]|USD|원/gi, '');
  } else {
    return { ok: false, error: tl('errFormat', { name }) };
  }
  if (s === '') {
    return allowEmpty ? { ok: true, value: 0 } : { ok: false, error: tl('errEmpty', { name }) };
  }
  if (!NUM_RE.test(s)) return { ok: false, error: tl('errDigitsOnly', { name, hint }) };
  const dot = s.indexOf('.');
  const dec = dot === -1 ? 0 : s.length - dot - 1;
  if (decimals !== undefined && dec > decimals) {
    return { ok: false, error: tl('errDecimals', { name, n: decimals }) };
  }
  const value = Number(s);
  if (!Number.isFinite(value)) return { ok: false, error: tl('errNotNumber', { name }) };
  if (minExclusive ? value <= min : value < min) {
    return { ok: false, error: tl(minExclusive ? 'errMinExcl' : 'errMinIncl', { name, min }) };
  }
  if (max !== undefined && value > max) {
    return { ok: false, error: tl('errMax', { name, max: fmtNumber(max) }) };
  }
  return { ok: true, value };
}

// 날짜 문자열을 YYYY-MM-DD로 바꿉니다. 2026-02-30 같은 날짜는 거부합니다.
// 시각이 붙은 값(2026-01-05 09:30)은 날짜 부분만 씁니다.
export function parseDate(raw, today = isoToday()) {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, error: tl('dateEmpty') };
  let s = raw.trim();
  const withTime = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})[ T]\d{1,2}:\d{2}/.exec(s);
  if (withTime) s = withTime[1];
  s = s.replace(/\s/g, '').replace(/\.$/, '');
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s) || /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) return { ok: false, error: tl('dateFormat') };
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return { ok: false, error: tl('dateInvalid') };
  }
  const iso = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (iso < TAX_CONSTANTS.limits.minDate) return { ok: false, error: tl('dateMin') };
  if (iso > today) return { ok: false, error: tl('dateFuture') };
  return { ok: true, value: iso };
}

// 구분: 매수/매도 한글·영문 표기와 "현금매수", "매수체결" 같은 변형을 받습니다.
export function parseSide(raw) {
  const s = String(raw ?? '').replace(/\s/g, '').toUpperCase();
  if (s === '매수' || s === 'BUY' || s === 'B') return { ok: true, value: 'BUY' };
  if (s === '매도' || s === 'SELL' || s === 'S') return { ok: true, value: 'SELL' };
  if (/취소|정정/.test(s)) return { ok: false, error: tl('sideCancel') };
  const buy = /매수|BUY|구매/.test(s);
  const sell = /매도|SELL|판매/.test(s);
  if (buy !== sell) return { ok: true, value: buy ? 'BUY' : 'SELL' };
  return { ok: false, error: tl('sideNeed') };
}

export function parseTicker(raw) {
  const s = String(raw ?? '').trim().toUpperCase();
  if (s === '') return { ok: false, error: tl('tickerEmpty') };
  if (!TICKER_RE.test(s)) return { ok: false, error: tl('tickerFormat') };
  return { ok: true, value: s };
}

// 계좌: 비우면 기본 계좌. 제어문자를 지우고 20자까지 받습니다.
export function parseAccount(raw) {
  const s = raw === undefined || raw === null ? '' : String(raw).replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (s === '') return { ok: true, value: DEFAULT_ACCOUNT };
  if (s.length > ACCOUNT_MAX) return { ok: false, error: tl('accountMax', { max: ACCOUNT_MAX }) };
  return { ok: true, value: s };
}

// 거래 한 건을 검증합니다. raw는 폼 입력이나 CSV 필드처럼 문자열이어도 됩니다.
export function validateTrade(raw, { today = isoToday() } = {}) {
  const L = TAX_CONSTANTS.limits;
  const errors = [];
  const pick = (field, res) => {
    if (res.ok) return res.value;
    errors.push({ field, message: res.error });
    return undefined;
  };
  const date = pick('date', parseDate(raw.date, today));
  const ticker = pick('ticker', parseTicker(raw.ticker));
  const side = pick('side', parseSide(raw.side));
  const qty = pick('qty', parseNumber(raw.qty, { name: tl('fieldQty'), decimals: L.qtyDecimals, min: 0, minExclusive: true, max: L.maxQty, example: '2.5' }));
  const price = pick('price', parseNumber(raw.price, { name: tl('fieldPrice'), decimals: L.priceDecimals, min: 0, minExclusive: true, max: L.maxPriceUSD, example: '185.20' }));
  const fee = pick('fee', parseNumber(raw.fee, { name: tl('fieldFee'), decimals: L.feeDecimals, min: 0, max: L.maxFeeUSD, allowEmpty: true, example: '0.5' }));
  const fx = pick('fx', parseNumber(raw.fx, { name: tl('fieldFx'), decimals: L.fxDecimals, min: L.minFxKRW, max: L.maxFxKRW, example: '1350.5' }));
  const account = pick('account', parseAccount(raw.account));
  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [], trade: { date, ticker, side, qty, price, fee, fx, account } };
}

// ---------- FIFO 원장 ----------

function sortTrades(trades, options) {
  const buyFirst = options.sameDayBuyFirst !== false;
  return trades.slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (buyFirst && a.side !== b.side) return a.side === 'BUY' ? -1 : 1;
    return a.seq - b.seq;
  });
}

// 거래 목록으로 FIFO 매칭을 수행합니다.
// lot은 계좌와 종목마다 따로 쌓입니다. 한 계좌에서 판 주식은 그 계좌에서 산 lot으로만 맞춥니다.
// 반환: sales(매도 건별 집계), openLots(잔여 매수 lot), errors(보유 초과 등 오류)
// 원화 금액은 계산 중에는 소수점을 유지하고, 매도 건 단위로 마지막에 1원 반올림합니다.
export function computeLedger(trades, options = DEFAULT_OPTIONS) {
  const feeOn = options.feeAsExpense !== false;
  const sorted = sortTrades(trades, { ...DEFAULT_OPTIONS, ...options });
  const lotsByKey = new Map();
  const sales = [];
  const errors = [];

  for (const t of sorted) {
    const account = accountOf(t);
    const key = lotKey(account, t.ticker);
    const lots = lotsByKey.get(key) || [];
    if (!lotsByKey.has(key)) lotsByKey.set(key, lots);

    if (t.side === 'BUY') {
      lots.push({
        buyId: t.id,
        account,
        ticker: t.ticker,
        date: t.date,
        qty: t.qty,
        remaining: t.qty,
        priceUSD: t.price,
        fxRate: t.fx,
        feePerShareUSD: t.fee / t.qty,
      });
      continue;
    }

    const held = lots.reduce((s, l) => s + l.remaining, 0);
    if (held + EPS < t.qty) {
      errors.push({
        tradeId: t.id,
        date: t.date,
        ticker: t.ticker,
        account,
        message: tl('errOverSell', { date: t.date, ticker: t.ticker, account, qty: t.qty, held: roundQtyText(held) }),
      });
      continue;
    }

    let need = t.qty;
    const slices = [];
    for (const lot of lots) {
      if (need <= EPS) break;
      if (lot.remaining <= EPS) continue;
      const take = Math.min(lot.remaining, need);
      slices.push({
        buyId: lot.buyId,
        buyDate: lot.date,
        qty: take,
        buyPriceUSD: lot.priceUSD,
        buyFxRate: lot.fxRate,
        costKRW: take * lot.priceUSD * lot.fxRate,
        buyFeeKRW: take * lot.feePerShareUSD * lot.fxRate,
        sellFeeKRW: (t.fee * (take / t.qty)) * t.fx,
      });
      lot.remaining -= take;
      if (lot.remaining < EPS) lot.remaining = 0;
      need -= take;
    }

    const proceedsRaw = t.qty * t.price * t.fx;
    const costRaw = slices.reduce((s, x) => s + x.costKRW, 0);
    const feeRaw = slices.reduce((s, x) => s + x.buyFeeKRW + x.sellFeeKRW, 0);
    const proceedsKRW = roundWon(proceedsRaw);
    const costKRW = roundWon(costRaw);
    const expenseKRW = feeOn ? roundWon(feeRaw) : 0;
    sales.push({
      id: t.id,
      date: t.date,
      year: Number(t.date.slice(0, 4)),
      account,
      ticker: t.ticker,
      qty: t.qty,
      priceUSD: t.price,
      fxRate: t.fx,
      proceedsKRW,
      costKRW,
      expenseKRW,
      gainKRW: proceedsKRW - costKRW - expenseKRW,
      slices,
      simulated: Boolean(t.simulated),
    });
  }

  const openLots = [];
  for (const lots of lotsByKey.values()) {
    for (const lot of lots) {
      if (lot.remaining <= EPS) continue;
      openLots.push({
        buyId: lot.buyId,
        account: lot.account,
        ticker: lot.ticker,
        date: lot.date,
        qty: lot.remaining,
        priceUSD: lot.priceUSD,
        fxRate: lot.fxRate,
        feePerShareUSD: lot.feePerShareUSD,
        costKRW: lot.remaining * lot.priceUSD * lot.fxRate,
        buyFeeKRW: lot.remaining * lot.feePerShareUSD * lot.fxRate,
      });
    }
  }
  return { sales, openLots, errors };
}

function roundQtyText(n) {
  return String(Math.round(n * 1e6) / 1e6);
}

// 거래에 쓰인 계좌 이름 (가나다순, 중복 없음)
export function accountsOf(trades) {
  return [...new Set(trades.map(accountOf))].sort((a, b) => a.localeCompare(b, 'ko'));
}

// 귀속 연도별 집계. 공제와 세율은 사람 단위로 한 번만 적용하므로 계좌를 합친 값으로 계산합니다.
// 이월 없음: 해당 연도 손익만 통산합니다.
export function summarizeYear(sales, year, constants = TAX_CONSTANTS) {
  const list = sales.filter((s) => s.year === year);
  let totalGain = 0;
  let totalLoss = 0;
  for (const s of list) {
    if (s.gainKRW > 0) totalGain += s.gainKRW;
    else if (s.gainKRW < 0) totalLoss += -s.gainKRW;
  }
  const net = totalGain - totalLoss;
  const deduction = constants.basicDeduction;
  const taxableBase = Math.max(0, net - deduction);
  return {
    year,
    saleCount: list.length,
    totalGain,
    totalLoss,
    net,
    deduction,
    taxableBase,
    rate: constants.totalRate,
    tax: computeTax(taxableBase, constants.totalRate),
    headroom: Math.max(0, deduction - net),
    highTierWarning: taxableBase > constants.highTierThreshold,
    lossCarryForward: constants.lossCarryForward,
    sales: list,
  };
}

// 계좌별 손익 (분리 보기). 세액은 계산하지 않습니다. 공제는 사람 단위 연 1회라 합산으로만 계산합니다.
export function summarizeByAccount(sales, year) {
  const map = new Map();
  for (const s of sales) {
    if (s.year !== year) continue;
    const account = s.account || DEFAULT_ACCOUNT;
    const r = map.get(account) || { account, saleCount: 0, totalGain: 0, totalLoss: 0, net: 0 };
    r.saleCount += 1;
    if (s.gainKRW > 0) r.totalGain += s.gainKRW;
    else if (s.gainKRW < 0) r.totalLoss += -s.gainKRW;
    r.net = r.totalGain - r.totalLoss;
    map.set(account, r);
  }
  return [...map.values()].sort((a, b) => a.account.localeCompare(b.account, 'ko'));
}

// 종목별 손익 집계. 같은 종목이라도 계좌가 다르면 계좌 합산 기준으로 한 줄입니다.
// 정렬은 손익 절댓값이 큰 순서입니다. 세액 계산에는 쓰지 않는 참고용 표입니다.
export function summarizeByTicker(sales, year) {
  const map = new Map();
  for (const s of sales) {
    if (s.year !== year) continue;
    const r = map.get(s.ticker) || { ticker: s.ticker, saleCount: 0, qty: 0, totalGain: 0, totalLoss: 0, net: 0 };
    r.saleCount += 1;
    r.qty += Number(s.qty) || 0;
    if (s.gainKRW > 0) r.totalGain += s.gainKRW;
    else if (s.gainKRW < 0) r.totalLoss += -s.gainKRW;
    r.net = r.totalGain - r.totalLoss;
    map.set(s.ticker, r);
  }
  return [...map.values()].sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || a.ticker.localeCompare(b.ticker, 'ko'));
}

// 종목별 손익 CSV. salesToCsv와 같은 형식(BOM, CRLF)을 씁니다.
export function tickerSummaryToCsv(rows) {
  const header = ['종목', '매도 건수', '매도 수량', '이익 합계(원)', '차손 합계(원)', '순손익(원)'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.ticker, r.saleCount, roundQtyText(r.qty), r.totalGain, r.totalLoss, r.net].map(csvField).join(','));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

// 연도별 비교표용 요약. 매도 목록은 빼고 숫자만 돌려줍니다.
export function compareYears(sales, years, constants = TAX_CONSTANTS) {
  return years.map((y) => {
    const { sales: _omit, ...row } = summarizeYear(sales, y, constants);
    return row;
  });
}

export function listYears(trades, options = DEFAULT_OPTIONS) {
  const { sales } = computeLedger(trades, options);
  const years = new Set(sales.map((s) => s.year));
  return [...years].sort((a, b) => a - b);
}

// ---------- 시뮬레이터 ----------

// 보유 lot 기준 미실현 손익 (매도 수수료 제외, 표시용). 계좌와 종목 단위로 나눕니다.
export function openPositions(openLots, prices, fxNow, options = DEFAULT_OPTIONS) {
  const feeOn = options.feeAsExpense !== false;
  const map = new Map();
  for (const lot of openLots) {
    const account = accountOf(lot);
    const key = lotKey(account, lot.ticker);
    const p = map.get(key) || { account, ticker: lot.ticker, qty: 0, costKRW: 0, lots: [] };
    p.qty += lot.qty;
    p.costKRW += lot.costKRW + (feeOn ? lot.buyFeeKRW : 0);
    p.lots.push(lot);
    map.set(key, p);
  }
  return [...map.values()]
    .sort((a, b) => (a.ticker !== b.ticker ? (a.ticker < b.ticker ? -1 : 1) : a.account.localeCompare(b.account, 'ko')))
    .map((p) => {
      const priceUSD = prices[p.ticker];
      const hasPrice = typeof priceUSD === 'number' && priceUSD > 0 && Number.isFinite(fxNow) && fxNow > 0;
      const valueKRW = hasPrice ? p.qty * priceUSD * fxNow : null;
      return {
        account: p.account,
        ticker: p.ticker,
        qty: p.qty,
        costKRW: p.costKRW,
        priceUSD: hasPrice ? priceUSD : null,
        valueKRW,
        unrealizedGainKRW: hasPrice ? valueKRW - p.costKRW : null,
        lots: p.lots,
      };
    });
}

// 가상 매도를 같은 FIFO 규칙으로 실제 원장에 더해 세금 변화를 계산합니다.
// sells: [{account?, ticker, qty, priceUSD}] (account를 생략하면 기본 계좌), 체결일은 today로 가정합니다.
export function simulateSales({ trades, sells, year, today = isoToday(), fxNow, feeRate = 0, options = DEFAULT_OPTIONS }) {
  const base = computeLedger(trades, options);
  if (base.errors.length) return { ok: false, errors: base.errors.map((e) => e.message) };
  const maxSeq = trades.reduce((m, t) => Math.max(m, t.seq), 0);
  const sims = sells
    .filter((s) => s.qty > 0)
    .map((s, i) => ({
      id: `sim-${i}`,
      date: today,
      account: s.account || DEFAULT_ACCOUNT,
      ticker: s.ticker,
      side: 'SELL',
      qty: s.qty,
      price: s.priceUSD,
      fee: feeRate * s.qty * s.priceUSD,
      fx: fxNow,
      seq: maxSeq + 1 + i,
      simulated: true,
    }));
  const after = computeLedger([...trades, ...sims], options);
  if (after.errors.length) return { ok: false, errors: after.errors.map((e) => e.message) };
  const before = summarizeYear(base.sales, year);
  const next = summarizeYear(after.sales, year);
  const simulatedSales = after.sales.filter((s) => s.simulated);
  return {
    ok: true,
    before,
    after: next,
    taxDelta: next.tax - before.tax,
    simulatedSales,
    simulatedGainKRW: simulatedSales.reduce((s, x) => s + x.gainKRW, 0),
  };
}

// 남은 250만원 공제 한도 활용 제안 (근사치).
// 계좌와 종목마다 FIFO 순서로 팔면서, 공제 여유 안에서 이익을 실현하는 수량을 계산합니다.
// 손실 lot은 FIFO 순서상 어차피 먼저 소진되므로 포함하며, 그만큼 여유가 늘어납니다.
// 반환: lots는 계좌·종목별 제안 수량, quantities는 종목별 합계(표시용).
// 정확한 세금은 simulateSales로 다시 확인해야 합니다.
export function suggestHeadroom({ trades, prices, fxNow, feeRate = 0, year, options = DEFAULT_OPTIONS }) {
  const feeOn = options.feeAsExpense !== false;
  const base = computeLedger(trades, options);
  if (base.errors.length) return { headroomKRW: 0, quantities: {}, lots: [], error: base.errors[0].message };
  const current = summarizeYear(base.sales, year);
  let budget = current.headroom;
  const candidates = [];
  for (const pos of openPositions(base.openLots, prices, fxNow, options)) {
    if (pos.priceUSD === null || !pos.lots.length) continue;
    const p = pos.priceUSD;
    const lots = pos.lots.map((lot) => {
      const perShare =
        p * fxNow * (feeOn ? 1 - feeRate : 1) -
        lot.priceUSD * lot.fxRate -
        (feeOn ? lot.feePerShareUSD * lot.fxRate : 0);
      return { qty: lot.qty, perShare };
    });
    candidates.push({ account: pos.account, ticker: pos.ticker, lots, first: lots[0].perShare });
  }
  candidates.sort((a, b) => a.first - b.first);

  const quantities = {};
  const lots = [];
  for (const c of candidates) {
    let sold = 0;
    for (const lot of c.lots) {
      if (lot.perShare <= 0) {
        sold += lot.qty;
        budget -= lot.qty * lot.perShare;
        continue;
      }
      const full = lot.qty * lot.perShare;
      if (full <= budget) {
        sold += lot.qty;
        budget -= full;
        continue;
      }
      const part = Math.floor((budget / lot.perShare) * 1e6) / 1e6;
      if (part > 0) {
        sold += part;
        budget -= part * lot.perShare;
      }
      break;
    }
    if (sold > 0) {
      const qty = Math.round(sold * 1e6) / 1e6;
      lots.push({ account: c.account, ticker: c.ticker, qty });
      quantities[c.ticker] = Math.round(((quantities[c.ticker] || 0) + qty) * 1e6) / 1e6;
    }
  }
  return { headroomKRW: current.headroom, quantities, lots, error: null };
}

// ---------- 신고 기간 ----------

function daysBetween(isoA, isoB) {
  const a = Date.UTC(...isoA.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  const b = Date.UTC(...isoB.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  return Math.round((b - a) / DAY_MS);
}

export function filingInfo(todayIso = isoToday(), constants = TAX_CONSTANTS) {
  const y = Number(todayIso.slice(0, 4));
  const { startMD, endMD } = constants.filingWindow;
  const endThis = `${y}-${endMD}`;
  const windowYear = todayIso > endThis ? y + 1 : y;
  const start = `${windowYear}-${startMD}`;
  const end = `${windowYear}-${endMD}`;
  const status = todayIso < start ? 'upcoming' : 'open';
  return {
    taxYear: windowYear - 1,
    start,
    end,
    status,
    dDay: daysBetween(todayIso, end),
  };
}

// ---------- CSV ----------

// 증권사별 열 이름을 모두 맞출 수는 없으므로, 흔한 표기를 필드별로 모아 둡니다.
// 비교 전에 공백, 밑줄, 하이픈, 괄호 안 단위(예: "단가(USD)")를 지웁니다.
export const HEADER_ALIASES = Object.freeze({
  date: ['날짜', '일자', '체결일', '체결일자', '체결날짜', '거래일', '거래일자', '주문일', '주문일자', '결제일', '매매일', '매매일자', 'date', 'tradedate', 'executeddate', 'orderdate'],
  ticker: ['종목', '종목코드', '티커', '심볼', '상품코드', '종목티커', 'ticker', 'symbol', 'code', 'stock'],
  side: ['구분', '매매구분', '거래구분', '체결구분', '주문구분', '매수매도', '매매', '종류', 'side', 'type', 'action'],
  qty: ['수량', '체결수량', '주문수량', '거래수량', '매매수량', 'qty', 'quantity', 'shares'],
  price: ['단가', '체결단가', '거래단가', '매매단가', '체결가', '체결가격', '가격', 'price', 'unitprice'],
  fee: ['수수료', '수수료합계', '제비용', 'fee', 'commission'],
  fx: ['환율', '적용환율', '거래환율', '체결환율', '기준환율', '매매기준율', '원화환율', 'fx', 'fxrate', 'exchangerate'],
  account: ['계좌', '계좌명', '계좌번호', '계좌구분', 'account', 'accountname'],
});
const FIELD_LABEL = { date: '날짜', ticker: '종목', side: '구분', qty: '수량', price: '단가', fee: '수수료', fx: '환율', account: '계좌' };
const fieldLabel = (f) => tl('fl_' + f); // localized name of a CSV field (the header aliases above stay as they are)
const REQUIRED_COLS = ['date', 'ticker', 'side', 'qty', 'price', 'fx'];
const POSITIONAL = ['date', 'ticker', 'side', 'qty', 'price', 'fee', 'fx'];
const MAX_CSV_ROWS = 5000;

const ALIAS_TO_FIELD = new Map();
for (const [field, names] of Object.entries(HEADER_ALIASES)) {
  for (const n of names) ALIAS_TO_FIELD.set(normalizeHeader(n), field);
}

export function normalizeHeader(raw) {
  return String(raw ?? '')
    .normalize('NFC')
    .replace(/\(.*?\)|\[.*?\]|（.*?）/g, '')
    .replace(/[\s_\-/]/g, '')
    .toLowerCase();
}

// 따옴표를 지원하는 CSV 분해기. 빈 줄은 제외하고 각 레코드의 시작 줄 번호를 기록합니다.
export function splitCsv(text, delim = ',') {
  const s = String(text).replace(/^﻿/, '');
  const records = [];
  let row = [];
  let field = '';
  let inQ = false;
  let line = 1;
  let rowLine = 1;
  let unterminated = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"') { inQ = true; continue; }
    if (c === delim) { row.push(field); field = ''; continue; }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      records.push({ line: rowLine, fields: row });
      row = [];
      field = '';
      line++;
      rowLine = line;
    } else {
      field += c;
    }
  }
  if (inQ) unterminated = true;
  if (field !== '' || row.length) {
    row.push(field);
    records.push({ line: rowLine, fields: row });
  }
  const out = records.filter((r) => r.fields.some((f) => f.trim() !== ''));
  if (unterminated) out.push({ line: rowLine, fields: null, unterminated: true });
  return out;
}

function detectDelimiter(text) {
  const firstLine = String(text).replace(/^﻿/, '').split(/\r?\n/, 1)[0] || '';
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return tabs > commas ? '\t' : ',';
}

// 헤더 행을 해석합니다. 필수 열이 없으면 missing에 한글 이름을 담습니다.
function readHeader(fields) {
  const columns = fields.map((h) => ALIAS_TO_FIELD.get(normalizeHeader(h)));
  const mapping = {};
  columns.forEach((field, idx) => {
    if (field && !(field in mapping)) mapping[field] = fields[idx].trim();
  });
  const missing = REQUIRED_COLS.filter((c) => !(c in mapping)).map((c) => tl('fieldRef', { label: fieldLabel(c), c }));
  // 원화 금액 열은 USD 필드로 읽으면 세금이 틀어지므로 파일 단위로 막습니다.
  const krwCols = fields
    .map((h, idx) => ({ h: h.trim(), field: columns[idx] }))
    .filter((x) => (x.field === 'price' || x.field === 'fee') && /\(원\)|₩|원\)?$/.test(x.h));
  return { columns, mapping, missing, krwCols };
}

// CSV 가져오기. 행마다 검증 결과를 돌려주고, 파일 전체가 잘못되면 fatal 메시지를 줍니다.
// 헤더가 있으면 열 이름으로, 없으면 date,ticker,side,qty,price,fee,fx 순서로 읽습니다.
// options.account: 계좌 열이 없거나 비어 있을 때 쓸 계좌 이름.
export function parseTradeCsv(text, { today = isoToday(), account } = {}) {
  const delim = detectDelimiter(text);
  const records = splitCsv(text, delim);
  if (records.length === 0) return { fatal: tl('csvEmpty'), rows: [], mapping: null };
  const bad = records.find((r) => r.unterminated);
  if (bad) return { fatal: tl('csvQuote', { line: bad.line }), rows: [], mapping: null };

  let columns;
  let mapping = null;
  let dataRecords;
  const head = readHeader(records[0].fields);
  if (head.columns.includes('date') && head.columns.includes('ticker')) {
    if (head.krwCols.length) {
      const names = head.krwCols.map((x) => `"${x.h}"`).join(', ');
      return {
        fatal: tl('csvKrwCols', { names }),
        rows: [], mapping: null,
      };
    }
    if (head.missing.length) {
      const seen = Object.entries(head.mapping).map(([f, h]) => tl('seenPair', { label: fieldLabel(f), h })).join(', ');
      return {
        fatal: tl('csvMissingCols', { missing: head.missing.join(', '), seen }),
        rows: [], mapping: null,
      };
    }
    columns = head.columns;
    mapping = head.mapping;
    dataRecords = records.slice(1);
  } else {
    columns = POSITIONAL;
    dataRecords = records;
  }
  if (dataRecords.length > MAX_CSV_ROWS) {
    return { fatal: tl('csvTooMany', { max: MAX_CSV_ROWS }), rows: [], mapping: null };
  }

  const rows = dataRecords.map((rec) => {
    const f = rec.fields;
    if (f.length !== columns.length) {
      return {
        line: rec.line, ok: false, trade: null,
        errors: [{ field: 'row', message: tl('csvColCount', { n: columns.length, got: f.length }) }],
      };
    }
    const raw = {};
    columns.forEach((name, idx) => {
      if (name) raw[name] = f[idx];
    });
    if (!mapping || !('account' in mapping)) raw.account = account;
    else if (!String(raw.account ?? '').trim()) raw.account = account;
    const res = validateTrade(raw, { today });
    return { line: rec.line, ok: res.ok, trade: res.ok ? res.trade : null, errors: res.errors };
  });
  return { fatal: null, rows, mapping: mapping || Object.fromEntries(POSITIONAL.map((f) => [f, tl('positional', { n: POSITIONAL.indexOf(f) + 1 })])) };
}

function csvField(v) {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// 신고용 요약 CSV: 매도 건별 한 행. Excel에서 한글이 깨지지 않도록 BOM을 붙입니다.
// 열 구성은 기존 신고용 형식과 같게 유지합니다 (계좌는 화면의 계좌별 보기에서 확인).
export function salesToCsv(sales) {
  const header = ['매도일', '종목', '수량', '양도가액(원)', '취득가액(원)', '필요경비(원)', '양도차익(원)'];
  const lines = [header.join(',')];
  for (const s of sales) {
    lines.push(
      [s.date, s.ticker, roundQtyText(s.qty), s.proceedsKRW, s.costKRW, s.expenseKRW, s.gainKRW].map(csvField).join(','),
    );
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// ---------- 백업 (JSON) ----------

export function makeBackup(trades, options = DEFAULT_OPTIONS, now = new Date()) {
  return JSON.stringify(
    {
      app: 'gainlot',
      schema: 1,
      exportedAt: now.toISOString(),
      options: { feeAsExpense: options.feeAsExpense !== false, sameDayBuyFirst: options.sameDayBuyFirst !== false },
      trades: trades.map((t) => ({
        id: t.id, date: t.date, account: accountOf(t), ticker: t.ticker, side: t.side,
        qty: t.qty, price: t.price, fee: t.fee, fx: t.fx,
      })),
    },
    null,
    2,
  );
}

export function parseBackup(text, { today = isoToday() } = {}) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, errors: [tl('backupNotJson')] };
  }
  if (!data || data.app !== 'gainlot' || data.schema !== 1 || !Array.isArray(data.trades)) {
    return { ok: false, errors: [tl('backupNotGainlot')] };
  }
  if (data.trades.length > 10000) return { ok: false, errors: [tl('backupTooMany')] };
  const errors = [];
  const trades = [];
  data.trades.forEach((raw, idx) => {
    const res = validateTrade(raw && typeof raw === 'object' ? raw : {}, { today });
    if (!res.ok) {
      errors.push(tl('backupRow', { idx: idx + 1, msg: res.errors.map((e) => e.message).join(' / ') }));
      return;
    }
    trades.push({ id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 64) : newId(), ...res.trade, seq: idx + 1 });
  });
  if (errors.length) return { ok: false, errors: errors.slice(0, 20) };
  const options = {
    feeAsExpense: data.options?.feeAsExpense !== false,
    sameDayBuyFirst: data.options?.sameDayBuyFirst !== false,
  };
  const check = computeLedger(trades, options);
  if (check.errors.length) return { ok: false, errors: check.errors.map((e) => e.message).slice(0, 20) };
  return { ok: true, errors: [], trades, options };
}

// ---------- 예시 데이터 ----------

// 빈 화면에서 기능을 둘러볼 때 쓰는 가상의 거래입니다. 실제 시세나 환율이 아닙니다.
// 두 계좌에 나눠 넣고, 2025년 매도도 포함해 연도 비교가 보이도록 했습니다.
export function sampleTrades() {
  const A = tl('sampleAcct1');
  const B = tl('sampleAcct2');
  const rows = [
    ['2024-06-03', 'MSFT', 'BUY', 5, 410, 1, 1330, A],
    ['2025-03-10', 'MSFT', 'SELL', 5, 440, 1, 1450, A],
    ['2026-01-05', 'AAPL', 'BUY', 10, 185.2, 0.5, 1342.1, A],
    ['2026-02-10', 'AAPL', 'BUY', 5, 190, 0.5, 1355, B],
    ['2026-03-10', 'AAPL', 'SELL', 4, 210, 0.5, 1355.4, A],
    ['2026-04-02', 'QQQ', 'BUY', 3, 480, 0.5, 1368, B],
    ['2026-06-15', 'AAPL', 'SELL', 5, 175, 0.5, 1380, B],
  ];
  return rows.map(([date, ticker, side, qty, price, fee, fx, account]) => ({ date, ticker, side, qty, price, fee, fx, account }));
}
