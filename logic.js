// 순수 계산 로직 (DOM 없음). 화면은 app.js가 담당합니다.
import { TAX_CONSTANTS, DEFAULT_OPTIONS } from './constants.js';

const EPS = 1e-9;
const TICKER_RE = /^[A-Z0-9][A-Z0-9.\-^]{0,11}$/;
const NUM_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
const DAY_MS = 86400000;

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

function daysBetween(isoA, isoB) {
  const a = Date.UTC(...isoA.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  const b = Date.UTC(...isoB.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  return Math.round((b - a) / DAY_MS);
}

// 세율 적용 (원 미만 절사). 부동소수 오차를 줄이려고 1e-6 단위에서 먼저 반올림합니다.
export function computeTax(taxable, rate = TAX_CONSTANTS.totalRate) {
  if (!(taxable > 0)) return 0;
  return Math.floor(Math.round(taxable * rate * 1e6) / 1e6);
}

// ---------- 입력 검증 ----------

// 문자열 또는 숫자를 받아 숫자로 바꿉니다. 빈 값은 allowEmpty 여부에 따라 처리합니다.
export function parseNumber(raw, opts) {
  const { name, decimals, min, max, minExclusive = false, allowEmpty = false } = opts;
  let s;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { ok: false, error: `${name}: 올바른 숫자가 아닙니다` };
    s = raw.toString();
    if (/e/i.test(s)) return { ok: false, error: `${name}: 값이 너무 작거나 큽니다` };
  } else if (raw === null || raw === undefined) {
    s = '';
  } else if (typeof raw === 'string') {
    s = raw.trim().replace(/[,\s$]/g, '');
  } else {
    return { ok: false, error: `${name}: 올바른 형식이 아닙니다` };
  }
  if (s === '') {
    return allowEmpty ? { ok: true, value: 0 } : { ok: false, error: `${name}: 값을 입력하세요` };
  }
  if (!NUM_RE.test(s)) return { ok: false, error: `${name}: 숫자만 입력하세요` };
  const dot = s.indexOf('.');
  const dec = dot === -1 ? 0 : s.length - dot - 1;
  if (decimals !== undefined && dec > decimals) {
    return { ok: false, error: `${name}: 소수점 ${decimals}자리까지 입력할 수 있습니다` };
  }
  const value = Number(s);
  if (!Number.isFinite(value)) return { ok: false, error: `${name}: 올바른 숫자가 아닙니다` };
  if (minExclusive ? value <= min : value < min) {
    return { ok: false, error: `${name}: ${minExclusive ? min + '보다 커야' : min + ' 이상이어야'} 합니다` };
  }
  if (max !== undefined && value > max) {
    return { ok: false, error: `${name}: ${max.toLocaleString('ko-KR')} 이하로 입력하세요` };
  }
  return { ok: true, value };
}

// 날짜 문자열을 YYYY-MM-DD로 바꿉니다. 2026-02-30 같은 날짜는 거부합니다.
export function parseDate(raw, today = isoToday()) {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, error: '날짜: 값을 입력하세요' };
  const s = raw.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s) || /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) return { ok: false, error: '날짜: YYYY-MM-DD 형식으로 입력하세요' };
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return { ok: false, error: '날짜: 존재하지 않는 날짜입니다' };
  }
  const iso = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (iso < TAX_CONSTANTS.limits.minDate) return { ok: false, error: '날짜: 2000년 이후만 입력할 수 있습니다' };
  if (iso > today) return { ok: false, error: '날짜: 오늘 이후 날짜는 입력할 수 없습니다' };
  return { ok: true, value: iso };
}

export function parseSide(raw) {
  const s = String(raw ?? '').trim().toUpperCase();
  if (s === '매수' || s === 'BUY' || s === 'B') return { ok: true, value: 'BUY' };
  if (s === '매도' || s === 'SELL' || s === 'S') return { ok: true, value: 'SELL' };
  return { ok: false, error: '구분: 매수 또는 매도를 입력하세요' };
}

export function parseTicker(raw) {
  const s = String(raw ?? '').trim().toUpperCase();
  if (s === '') return { ok: false, error: '종목: 티커를 입력하세요' };
  if (!TICKER_RE.test(s)) return { ok: false, error: '종목: 영문 대문자, 숫자, 점(.), 하이픈(-)만 가능합니다 (최대 12자)' };
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
  const qty = pick('qty', parseNumber(raw.qty, { name: '수량', decimals: L.qtyDecimals, min: 0, minExclusive: true, max: L.maxQty }));
  const price = pick('price', parseNumber(raw.price, { name: '단가(USD)', decimals: L.priceDecimals, min: 0, minExclusive: true, max: L.maxPriceUSD }));
  const fee = pick('fee', parseNumber(raw.fee, { name: '수수료(USD)', decimals: L.feeDecimals, min: 0, max: L.maxFeeUSD, allowEmpty: true }));
  const fx = pick('fx', parseNumber(raw.fx, { name: '환율(원/달러)', decimals: L.fxDecimals, min: L.minFxKRW, max: L.maxFxKRW }));
  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [], trade: { date, ticker, side, qty, price, fee, fx } };
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
// 반환: sales(매도 건별 집계), openLots(잔여 매수 lot), errors(보유 초과 등 오류)
// 원화 금액은 계산 중에는 소수점을 유지하고, 매도 건 단위로 마지막에 1원 반올림합니다.
export function computeLedger(trades, options = DEFAULT_OPTIONS) {
  const feeOn = options.feeAsExpense !== false;
  const sorted = sortTrades(trades, { ...DEFAULT_OPTIONS, ...options });
  const lotsByTicker = new Map();
  const sales = [];
  const errors = [];

  for (const t of sorted) {
    const lots = lotsByTicker.get(t.ticker) || [];
    if (!lotsByTicker.has(t.ticker)) lotsByTicker.set(t.ticker, lots);

    if (t.side === 'BUY') {
      lots.push({
        buyId: t.id,
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
        message: `${t.date} ${t.ticker} 매도 ${t.qty}주가 보유 ${roundQtyText(held)}주를 초과합니다`,
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
  for (const lots of lotsByTicker.values()) {
    for (const lot of lots) {
      if (lot.remaining <= EPS) continue;
      openLots.push({
        buyId: lot.buyId,
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

// 귀속 연도별 집계. 이월 없음: 해당 연도 손익만 통산합니다.
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

export function listYears(trades, options = DEFAULT_OPTIONS) {
  const { sales } = computeLedger(trades, options);
  const years = new Set(sales.map((s) => s.year));
  return [...years].sort((a, b) => a - b);
}

// ---------- 시뮬레이터 ----------

// 보유 lot 기준 미실현 손익 (매도 수수료 제외, 표시용)
export function openPositions(openLots, prices, fxNow, options = DEFAULT_OPTIONS) {
  const feeOn = options.feeAsExpense !== false;
  const map = new Map();
  for (const lot of openLots) {
    const p = map.get(lot.ticker) || { ticker: lot.ticker, qty: 0, costKRW: 0, lots: [] };
    p.qty += lot.qty;
    p.costKRW += lot.costKRW + (feeOn ? lot.buyFeeKRW : 0);
    p.lots.push(lot);
    map.set(lot.ticker, p);
  }
  return [...map.values()]
    .sort((a, b) => (a.ticker < b.ticker ? -1 : 1))
    .map((p) => {
      const priceUSD = prices[p.ticker];
      const hasPrice = typeof priceUSD === 'number' && priceUSD > 0 && Number.isFinite(fxNow) && fxNow > 0;
      const valueKRW = hasPrice ? p.qty * priceUSD * fxNow : null;
      return {
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
// sells: [{ticker, qty, priceUSD}], 체결일은 today로 가정합니다.
export function simulateSales({ trades, sells, year, today = isoToday(), fxNow, feeRate = 0, options = DEFAULT_OPTIONS }) {
  const base = computeLedger(trades, options);
  if (base.errors.length) return { ok: false, errors: base.errors.map((e) => e.message) };
  const maxSeq = trades.reduce((m, t) => Math.max(m, t.seq), 0);
  const sims = sells
    .filter((s) => s.qty > 0)
    .map((s, i) => ({
      id: `sim-${i}`,
      date: today,
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
// 각 종목을 FIFO 순서로 팔면서, 공제 여유 안에서 이익을 실현하는 수량을 계산합니다.
// 손실 lot은 FIFO 순서상 어차피 먼저 소진되므로 포함하며, 그만큼 여유가 늘어납니다.
// 정확한 세금은 simulateSales로 다시 확인해야 합니다.
export function suggestHeadroom({ trades, prices, fxNow, feeRate = 0, year, options = DEFAULT_OPTIONS }) {
  const feeOn = options.feeAsExpense !== false;
  const base = computeLedger(trades, options);
  if (base.errors.length) return { headroomKRW: 0, quantities: {}, error: base.errors[0].message };
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
    candidates.push({ ticker: pos.ticker, lots, first: lots[0].perShare });
  }
  candidates.sort((a, b) => a.first - b.first);

  const quantities = {};
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
    if (sold > 0) quantities[c.ticker] = Math.round(sold * 1e6) / 1e6;
  }
  return { headroomKRW: current.headroom, quantities, error: null };
}

// ---------- 신고 기간 ----------

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

const HEADER_MAP = {
  date: 'date', 날짜: 'date', 체결일: 'date', 거래일: 'date',
  ticker: 'ticker', symbol: 'ticker', 종목: 'ticker', 종목코드: 'ticker',
  side: 'side', type: 'side', 구분: 'side', 매수매도: 'side',
  qty: 'qty', quantity: 'qty', 수량: 'qty',
  price: 'price', 단가: 'price', 가격: 'price',
  fee: 'fee', 수수료: 'fee',
  fx: 'fx', fxrate: 'fx', 환율: 'fx',
};
const REQUIRED_COLS = ['date', 'ticker', 'side', 'qty', 'price', 'fx'];
const POSITIONAL = ['date', 'ticker', 'side', 'qty', 'price', 'fee', 'fx'];
const MAX_CSV_ROWS = 5000;

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

// CSV 가져오기. 행마다 검증 결과를 돌려주고, 파일 전체가 잘못되면 fatal 메시지를 줍니다.
// 헤더가 있으면 열 이름으로, 없으면 date,ticker,side,qty,price,fee,fx 순서로 읽습니다.
export function parseTradeCsv(text, { today = isoToday() } = {}) {
  const delim = detectDelimiter(text);
  const records = splitCsv(text, delim);
  if (records.length === 0) return { fatal: '가져올 내용이 없습니다.', rows: [] };
  const bad = records.find((r) => r.unterminated);
  if (bad) return { fatal: `${bad.line}행: 따옴표가 닫히지 않았습니다.`, rows: [] };

  let columns;
  let dataRecords;
  const first = records[0].fields.map((f) => HEADER_MAP[f.trim().toLowerCase().replace(/[\s_]/g, '')]);
  const recognized = new Set(first.filter(Boolean));
  if (recognized.has('date') && recognized.has('ticker')) {
    const missing = REQUIRED_COLS.filter((c) => !recognized.has(c));
    if (missing.length) return { fatal: `헤더에 다음 열이 필요합니다: ${missing.join(', ')}`, rows: [] };
    columns = first;
    dataRecords = records.slice(1);
  } else {
    columns = POSITIONAL;
    dataRecords = records;
  }
  if (dataRecords.length > MAX_CSV_ROWS) {
    return { fatal: `한 번에 ${MAX_CSV_ROWS}행까지 가져올 수 있습니다.`, rows: [] };
  }

  const rows = dataRecords.map((rec) => {
    const f = rec.fields;
    if (f.length !== columns.length) {
      return { line: rec.line, ok: false, trade: null, errors: [{ field: 'row', message: `열 개수가 ${columns.length}개여야 하는데 ${f.length}개입니다` }] };
    }
    const raw = {};
    columns.forEach((name, idx) => {
      if (name) raw[name] = f[idx];
    });
    const res = validateTrade(raw, { today });
    return { line: rec.line, ok: res.ok, trade: res.ok ? res.trade : null, errors: res.errors };
  });
  return { fatal: null, rows };
}

function csvField(v) {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// 신고용 요약 CSV: 매도 건별 한 행. Excel에서 한글이 깨지지 않도록 BOM을 붙입니다.
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
      trades: trades.map((t) => ({ id: t.id, date: t.date, ticker: t.ticker, side: t.side, qty: t.qty, price: t.price, fee: t.fee, fx: t.fx })),
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
    return { ok: false, errors: ['JSON 형식이 아닙니다.'] };
  }
  if (!data || data.app !== 'gainlot' || data.schema !== 1 || !Array.isArray(data.trades)) {
    return { ok: false, errors: ['gainlot 백업 파일(schema 1)이 아닙니다.'] };
  }
  if (data.trades.length > 10000) return { ok: false, errors: ['거래가 10,000건을 넘습니다.'] };
  const errors = [];
  const trades = [];
  data.trades.forEach((raw, idx) => {
    const res = validateTrade(raw && typeof raw === 'object' ? raw : {}, { today });
    if (!res.ok) {
      errors.push(`${idx + 1}번째 거래: ${res.errors.map((e) => e.message).join(' / ')}`);
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
