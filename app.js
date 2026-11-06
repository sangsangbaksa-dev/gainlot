// 화면 제어. 계산은 logic.js와 ai.js에 있고, 여기서는 입력을 읽고 결과를 그립니다.
// 사용자 데이터는 textContent로만 넣습니다 (innerHTML 사용 안 함).
import { TAX_CONSTANTS, DEFAULT_OPTIONS, FX_BASIS_NOTE } from './constants.js';
import {
  newId, isoToday, parseNumber, validateTrade, computeLedger, summarizeYear, listYears,
  openPositions, simulateSales, suggestHeadroom, filingInfo, parseTradeCsv, salesToCsv,
  makeBackup, parseBackup,
} from './logic.js';
import { buildPayload, ruleBasedAnalysis, sendToAnthropic, isPlausibleKey } from './ai.js';

const KEY = {
  trades: 'gainlot-trades',
  settings: 'gainlot-settings',
  checklist: 'gainlot-checklist',
  prices: 'gainlot-prices',
  aiKey: 'gainlot-ai-key',
};
const LIM = TAX_CONSTANTS.limits;
const CHECKLIST = [
  { id: 'stmt', title: '해외 증권사 연간 매매명세(거래내역서)', note: '체결일, 종목, 수량, 단가(USD), 수수료가 모두 나오는지 확인하세요.' },
  { id: 'fx', title: '환율 근거 자료', note: '거래일 또는 결제일 기준환율 중 무엇을 썼는지 출처와 함께 남기세요. 기준 선택은 세무 판단입니다.' },
  { id: 'fee', title: '외화 수수료 기록', note: '매수·매도 수수료(USD)와 원화 환산 내역. 필요경비 산입 여부를 확인하세요.' },
  { id: 'transfer', title: '원화 송금 · 외화 환전 내역', note: '취득 자금의 출처와 환전 환율을 증명할 수 있는 입출금 기록.' },
  { id: 'other', title: '배당·이자 등 다른 해외 소득 확인', note: '양도소득과 별도로 신고할 소득이 있는지 확인하세요.' },
  { id: 'loss', title: '손실 이월 여부 확인', note: '양도 결손금은 다음 해로 넘어가지 않습니다. 같은 해 손익만 통산합니다.' },
  { id: 'account', title: '해외금융계좌 신고 대상 여부', note: '보유 계좌 잔액 기준의 별도 신고 의무가 있는지 확인하세요.' },
  { id: 'csv', title: '신고용 CSV 내려받기 및 대조', note: '계산기의 매도 건별 금액과 증권사 자료가 일치하는지 대조하세요.' },
];

const state = {
  trades: [],
  options: { ...DEFAULT_OPTIONS },
  lastFx: TAX_CONSTANTS.defaultFxKRW,
  simFx: TAX_CONSTANTS.defaultFxKRW,
  simFeePct: '',
  prices: {},
  sims: {},
  checklist: {},
  editingId: null,
  year: null,
  aiKey: '',
  storageFailed: false,
  aiBusy: false,
};

// ---------- 공통 유틸 ----------

const $ = (id) => document.getElementById(id);
const thisYear = () => Number(isoToday().slice(0, 4));
const fmtWon = (n) => `${(Math.round(n) || 0).toLocaleString('ko-KR')}원`;
const fmtSigned = (n) => {
  const v = Math.round(n) || 0;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('ko-KR')}원`;
};
const fmtQty = (n) => n.toLocaleString('ko-KR', { maximumFractionDigits: 6 });
const fmtUsd = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 4 });
const fmtRate = (n) => n.toLocaleString('ko-KR', { maximumFractionDigits: 2 });

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    state.storageFailed = true;
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    state.storageFailed = true;
  }
}

function download(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ledger() {
  return computeLedger(state.trades, state.options);
}

function tradeKey(t) {
  return [t.date, t.ticker, t.side, t.qty, t.price, t.fee, t.fx].join('|');
}

function nextSeq() {
  return state.trades.reduce((m, t) => Math.max(m, t.seq || 0), 0) + 1;
}

// ---------- 저장 ----------

function loadAll() {
  const settings = readJson(KEY.settings, {});
  if (settings && typeof settings === 'object') {
    if (settings.options && typeof settings.options === 'object') {
      state.options = {
        feeAsExpense: settings.options.feeAsExpense !== false,
        sameDayBuyFirst: settings.options.sameDayBuyFirst !== false,
      };
    }
    if (Number.isFinite(settings.lastFx)) state.lastFx = settings.lastFx;
    if (Number.isFinite(settings.simFx)) state.simFx = settings.simFx;
    if (typeof settings.simFeePct === 'string') state.simFeePct = settings.simFeePct;
  }
  const checklist = readJson(KEY.checklist, {});
  if (checklist && typeof checklist === 'object') state.checklist = checklist;
  const prices = readJson(KEY.prices, {});
  if (prices && typeof prices === 'object') {
    for (const [t, v] of Object.entries(prices)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) state.prices[t] = v;
    }
  }
  const stored = readJson(KEY.trades, []);
  const today = isoToday();
  if (Array.isArray(stored)) {
    stored.forEach((raw, i) => {
      const res = validateTrade(raw && typeof raw === 'object' ? raw : {}, { today });
      if (!res.ok) return;
      state.trades.push({
        id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
        ...res.trade,
        seq: Number.isFinite(raw.seq) ? raw.seq : i + 1,
      });
    });
  }
  try {
    state.aiKey = localStorage.getItem(KEY.aiKey) || '';
  } catch {
    state.storageFailed = true;
  }
}

function saveTrades() {
  writeJson(KEY.trades, state.trades);
}
function saveSettings() {
  writeJson(KEY.settings, {
    options: state.options,
    lastFx: state.lastFx,
    simFx: state.simFx,
    simFeePct: state.simFeePct,
  });
}
function savePrices() {
  writeJson(KEY.prices, state.prices);
}

// 거래 목록을 바꾸기 전에 항상 원장을 다시 계산합니다. 오류가 있으면 저장하지 않습니다.
function commitTrades(next) {
  const check = computeLedger(next, state.options);
  if (check.errors.length) return { ok: false, message: check.errors[0].message };
  state.trades = next;
  saveTrades();
  renderAll();
  return { ok: true };
}

// ---------- 공통 렌더 ----------

function renderAll() {
  renderRulesBadge();
  renderLedgerAlert();
  renderTrades();
  renderYear();
  renderSim();
  renderFiling();
  renderAi();
}

function renderRulesBadge() {
  const { appliesTo, asOf, basicDeduction, totalRate } = TAX_CONSTANTS;
  $('rules-badge').textContent =
    `적용 기준: ${appliesTo} · ${asOf} · 기본공제 ${basicDeduction.toLocaleString('ko-KR')}원 · 세율 ${Math.round(totalRate * 100)}%`;
  $('fx-note').textContent = FX_BASIS_NOTE;
  $('storage-notice').hidden = !state.storageFailed;
  if (state.storageFailed) {
    $('storage-notice').textContent =
      '이 브라우저에서 저장 공간을 쓸 수 없어 변경 내용이 새로고침 후 사라질 수 있습니다. JSON 백업을 받아 두세요.';
  }
}

function renderLedgerAlert() {
  const { errors } = ledger();
  const box = $('ledger-alert');
  box.replaceChildren();
  box.hidden = errors.length === 0;
  if (errors.length) {
    box.append(el('strong', { text: '계산을 확정할 수 없는 거래가 있습니다.' }));
    for (const e of errors.slice(0, 5)) box.append(el('p', { text: e.message }));
  }
}

// ---------- 거래 입력 ----------

const form = $('trade-form');

function setFormDefaults() {
  form.elements.date.value = isoToday();
  form.elements.date.max = isoToday();
  form.elements.date.min = LIM.minDate;
  form.elements.fx.value = String(state.lastFx);
}

function clearFormErrors() {
  for (const id of ['date', 'ticker', 'side', 'qty', 'price', 'fee', 'fx']) {
    const node = $(`e-${id}`);
    if (node) node.textContent = '';
    form.elements[id]?.removeAttribute('aria-invalid');
  }
  $('trade-form-error').textContent = '';
}

function showFieldErrors(errors) {
  for (const e of errors) {
    const node = $(`e-${e.field}`);
    if (node) node.textContent = e.message;
    form.elements[e.field]?.setAttribute('aria-invalid', 'true');
  }
  const first = errors[0] && form.elements[errors[0].field];
  if (first) first.focus();
}

function readForm() {
  const f = form.elements;
  return {
    date: f.date.value,
    ticker: f.ticker.value,
    side: f.side.value,
    qty: f.qty.value,
    price: f.price.value,
    fee: f.fee.value,
    fx: f.fx.value,
  };
}

function resetTradeFormKeepContext() {
  const f = form.elements;
  f.qty.value = '';
  f.price.value = '';
  f.fee.value = '';
}

function cancelEdit() {
  state.editingId = null;
  form.reset();
  setFormDefaults();
  $('trade-form-title').textContent = '거래 입력';
  $('trade-submit').textContent = '거래 추가';
  $('trade-cancel').hidden = true;
  clearFormErrors();
}

function startEdit(id) {
  const t = state.trades.find((x) => x.id === id);
  if (!t) return;
  const f = form.elements;
  f.date.value = t.date;
  f.ticker.value = t.ticker;
  f.side.value = t.side;
  f.qty.value = String(t.qty);
  f.price.value = String(t.price);
  f.fee.value = String(t.fee);
  f.fx.value = String(t.fx);
  state.editingId = id;
  clearFormErrors();
  $('trade-form-title').textContent = '거래 수정';
  $('trade-submit').textContent = '수정 저장';
  $('trade-cancel').hidden = false;
  f.ticker.focus();
  form.scrollIntoView({ block: 'nearest' });
}

function submitTrade(e) {
  e.preventDefault();
  clearFormErrors();
  const res = validateTrade(readForm(), { today: isoToday() });
  if (!res.ok) {
    showFieldErrors(res.errors);
    return;
  }
  let next;
  if (state.editingId) {
    next = state.trades.map((t) => (t.id === state.editingId ? { ...t, ...res.trade } : t));
  } else {
    next = [...state.trades, { id: newId(), ...res.trade, seq: nextSeq() }];
  }
  const out = commitTrades(next);
  if (!out.ok) {
    $('trade-form-error').textContent = out.message;
    return;
  }
  state.lastFx = res.trade.fx;
  saveSettings();
  if (state.editingId) cancelEdit();
  else {
    resetTradeFormKeepContext();
    form.elements.qty.focus();
  }
}

function removeTrade(id) {
  const t = state.trades.find((x) => x.id === id);
  if (!t) return;
  if (!window.confirm(`${t.date} ${t.ticker} ${t.side === 'BUY' ? '매수' : '매도'} 거래를 삭제할까요?`)) return;
  const out = commitTrades(state.trades.filter((x) => x.id !== id));
  if (!out.ok) window.alert(`삭제하면 계산이 깨집니다.\n${out.message}`);
  if (state.editingId === id) cancelEdit();
}

function renderTrades() {
  const body = $('trade-body');
  body.replaceChildren();
  const list = state.trades.slice().sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : b.seq - a.seq));
  $('trade-count').textContent = list.length ? `${list.length}건` : '';
  $('trade-empty').hidden = list.length > 0;
  $('trade-table-wrap').hidden = list.length === 0;
  for (const t of list) {
    body.append(
      el(
        'tr',
        {},
        el('td', { text: t.date }),
        el('td', { text: t.ticker }),
        el('td', {}, el('span', { class: t.side === 'BUY' ? 'tag buy' : 'tag sell', text: t.side === 'BUY' ? '매수' : '매도' })),
        el('td', { class: 'num', text: fmtQty(t.qty) }),
        el('td', { class: 'num', text: fmtUsd(t.price) }),
        el('td', { class: 'num', text: fmtUsd(t.fee) }),
        el('td', { class: 'num', text: fmtRate(t.fx) }),
        el('td', { class: 'num', text: fmtWon(t.qty * t.price * t.fx) }),
        el(
          'td',
          { class: 'row-actions' },
          el('button', { type: 'button', class: 'btn btn-ghost btn-xs', 'aria-label': `${t.date} ${t.ticker} 거래 수정`, text: '수정', onclick: () => startEdit(t.id) }),
          el('button', { type: 'button', class: 'btn btn-danger-ghost btn-xs', 'aria-label': `${t.date} ${t.ticker} 거래 삭제`, text: '삭제', onclick: () => removeTrade(t.id) }),
        ),
      ),
    );
  }
}

// ---------- CSV / 백업 ----------

function showReport(lines, tone = 'info') {
  const box = $('csv-report');
  box.replaceChildren();
  box.className = tone;
  for (const l of lines) box.append(el('p', { text: l }));
}

function importCsv() {
  const res = parseTradeCsv($('csv-text').value, { today: isoToday() });
  if (res.fatal) {
    showReport([`가져오지 않았습니다. ${res.fatal}`], 'error');
    return;
  }
  const existing = new Set(state.trades.map(tradeKey));
  let seq = nextSeq();
  const added = [];
  const skipped = [];
  let dup = 0;
  for (const row of res.rows) {
    if (!row.ok) {
      skipped.push(`${row.line}행: ${row.errors.map((e) => e.message).join(' / ')}`);
      continue;
    }
    if (existing.has(tradeKey(row.trade))) {
      dup += 1;
      continue;
    }
    added.push({ id: newId(), ...row.trade, seq: seq++ });
  }
  const merged = state.trades.concat(added);
  const check = computeLedger(merged, state.options);
  if (check.errors.length) {
    showReport(['가져오기를 취소했습니다. 다음 매도가 보유 수량을 넘습니다.', ...check.errors.slice(0, 5).map((e) => e.message)], 'error');
    return;
  }
  if (added.length) {
    state.trades = merged;
    saveTrades();
    renderAll();
  }
  const lines = [`${added.length}건을 가져왔습니다. 이미 있던 거래 ${dup}건, 오류 ${skipped.length}행은 건너뛰었습니다.`];
  lines.push(...skipped.slice(0, 30));
  if (skipped.length > 30) lines.push(`오류 행이 ${skipped.length - 30}개 더 있습니다.`);
  showReport(lines, skipped.length || dup ? 'warn' : 'ok');
}

function bindBackup() {
  $('backup-export').addEventListener('click', () => {
    download(`gainlot-backup-${isoToday()}.json`, 'application/json', makeBackup(state.trades, state.options, new Date()));
  });
  $('backup-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    $('backup-error').textContent = '';
    if (!file) return;
    if (file.size > 5000000) {
      $('backup-error').textContent = '백업 파일이 너무 큽니다 (5MB 제한).';
      return;
    }
    const res = parseBackup(await file.text(), { today: isoToday() });
    if (!res.ok) {
      $('backup-error').textContent = `불러오지 않았습니다. ${res.errors.slice(0, 3).join(' ')}`;
      return;
    }
    if (!window.confirm(`현재 거래 ${state.trades.length}건을 백업의 ${res.trades.length}건으로 바꿀까요?`)) return;
    state.trades = res.trades;
    state.options = res.options;
    saveTrades();
    saveSettings();
    renderAll();
    renderOptions();
  });
  $('clear-all').addEventListener('click', () => {
    if (!state.trades.length) return;
    if (!window.confirm('모든 거래를 삭제합니다. 되돌릴 수 없습니다. 계속할까요?')) return;
    state.trades = [];
    saveTrades();
    cancelEdit();
    renderAll();
  });
}

// ---------- 연간 요약 ----------

function renderOptions() {
  $('opt-fee').checked = state.options.feeAsExpense;
  $('opt-sameday').checked = state.options.sameDayBuyFirst;
}

function renderYear() {
  const years = listYears(state.trades, state.options);
  const select = $('year-select');
  select.replaceChildren();
  const list = years.length ? years : [thisYear()];
  for (const y of list.slice().reverse()) select.append(el('option', { value: y, text: `${y}년 귀속` }));
  if (!state.year || !list.includes(state.year)) state.year = list[list.length - 1];
  select.value = String(state.year);

  const { sales } = ledger();
  const s = summarizeYear(sales, state.year);
  const grid = $('year-summary');
  grid.replaceChildren();
  const card = (label, value, note, extra = '') =>
    el('div', { class: `stat ${extra}` }, el('p', { class: 'stat-label', text: label }), el('p', { class: 'stat-value', text: value }), note ? el('p', { class: 'hint', text: note }) : null);
  grid.append(
    card('양도차익 합계', fmtWon(s.totalGain), `매도 ${s.saleCount}건 중 이익 건 합계`),
    card('양도차손 합계', fmtWon(s.totalLoss), '같은 해 이익과 통산합니다'),
    card('순손익', fmtSigned(s.net), '다른 해 손실은 이월되지 않습니다'),
    card('기본공제', fmtWon(s.deduction), '연 1회, 소득 종류 전체에 적용'),
    card('과세표준', fmtWon(s.taxableBase), '순손익에서 기본공제를 뺀 금액'),
    card(`예상 세액 (${Math.round(s.rate * 100)}%)`, fmtWon(s.tax), '원 미만 절사', 'stat-key'),
    card('공제 여유', fmtWon(s.headroom), '이 금액까지 이익을 실현해도 세금 0원'),
  );
  const notes = $('year-notes');
  notes.textContent = s.highTierWarning
    ? '과세표준이 3억 원을 넘습니다. 이 계산기는 3억 초과 구간의 추가 세율을 적용하지 않으므로 세무사와 반드시 확인하세요.'
    : `${state.year}년 손익만 계산합니다. 손실은 다음 해로 넘어가지 않습니다. 세율은 지방소득세 포함 ${Math.round(s.rate * 100)}%로 단순 적용합니다.`;

  $('sale-count').textContent = s.saleCount ? `${s.saleCount}건` : '';
  $('sale-empty').hidden = s.saleCount > 0;
  const list2 = $('sale-list');
  list2.replaceChildren();
  for (const sale of s.sales) list2.append(saleDetails(sale));
}

function saleDetails(sale) {
  const gainClass = sale.gainKRW < 0 ? 'neg' : sale.gainKRW > 0 ? 'pos' : '';
  const rows = sale.slices.map((x) =>
    el(
      'tr',
      {},
      el('td', { text: x.buyDate }),
      el('td', { class: 'num', text: fmtQty(x.qty) }),
      el('td', { class: 'num', text: fmtUsd(x.buyPriceUSD) }),
      el('td', { class: 'num', text: fmtRate(x.buyFxRate) }),
      el('td', { class: 'num', text: fmtWon(x.costKRW) }),
      el('td', { class: 'num', text: fmtWon(state.options.feeAsExpense ? x.buyFeeKRW + x.sellFeeKRW : 0) }),
    ),
  );
  return el(
    'details',
    { class: 'sale' },
    el(
      'summary',
      {},
      el('span', { class: 'sale-title', text: `${sale.date} · ${sale.ticker} · ${fmtQty(sale.qty)}주` }),
      el('span', { class: `sale-gain ${gainClass}`, text: fmtSigned(sale.gainKRW) }),
    ),
    el(
      'dl',
      { class: 'sale-figs' },
      el('div', {}, el('dt', { text: '양도가액' }), el('dd', { text: fmtWon(sale.proceedsKRW) })),
      el('div', {}, el('dt', { text: '취득가액' }), el('dd', { text: fmtWon(sale.costKRW) })),
      el('div', {}, el('dt', { text: '필요경비' }), el('dd', { text: fmtWon(sale.expenseKRW) })),
      el('div', {}, el('dt', { text: '매도 단가 · 환율' }), el('dd', { text: `$${fmtUsd(sale.priceUSD)} · ${fmtRate(sale.fxRate)}원` })),
    ),
    el('p', { class: 'hint', text: '사용한 매수 lot (선입선출). 각 칸은 1원 단위로 표시하며, 합계는 매도 건 단위로 다시 반올림합니다.' }),
    el(
      'div',
      { class: 'table-scroll' },
      el(
        'table',
        { class: 'data compact' },
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', { scope: 'col', text: '매수일' }),
            el('th', { scope: 'col', class: 'num', text: '수량' }),
            el('th', { scope: 'col', class: 'num', text: '매수 단가($)' }),
            el('th', { scope: 'col', class: 'num', text: '매수 환율' }),
            el('th', { scope: 'col', class: 'num', text: '취득가(원)' }),
            el('th', { scope: 'col', class: 'num', text: '수수료(원)' }),
          ),
        ),
        el('tbody', {}, rows),
      ),
    ),
  );
}

function bindYear() {
  $('year-select').addEventListener('change', (e) => {
    state.year = Number(e.target.value);
    renderYear();
  });
  $('opt-fee').addEventListener('change', (e) => setOption('feeAsExpense', e.target.checked));
  $('opt-sameday').addEventListener('change', (e) => setOption('sameDayBuyFirst', e.target.checked));
  $('export-year').addEventListener('click', () => {
    const { sales } = ledger();
    const s = summarizeYear(sales, state.year);
    if (!s.saleCount) {
      window.alert(`${state.year}년 매도 거래가 없어 내려받을 내용이 없습니다.`);
      return;
    }
    download(`gainlot-${state.year}-매도내역.csv`, 'text/csv;charset=utf-8', salesToCsv(s.sales));
  });
}

function setOption(key, value) {
  const next = { ...state.options, [key]: value };
  const check = computeLedger(state.trades, next);
  if (check.errors.length) {
    window.alert(`이 옵션으로 바꾸면 계산이 깨집니다.\n${check.errors[0].message}`);
    renderOptions();
    return;
  }
  state.options = next;
  saveSettings();
  renderAll();
}

// ---------- 절세 시뮬레이터 ----------

const simRowRefs = new Map();

function currentSimInputs() {
  const feeRes = parseNumber(state.simFeePct, { name: '수수료율', decimals: 3, min: 0, max: 10, allowEmpty: true });
  return {
    fxNow: state.simFx,
    feeRate: feeRes.ok ? feeRes.value / 100 : 0,
  };
}

function renderSim() {
  const year = thisYear();
  $('sim-year').textContent = `${year}년 실현분 기준`;
  if (document.activeElement !== $('sim-fx')) $('sim-fx').value = String(state.simFx);
  if (document.activeElement !== $('sim-fee')) $('sim-fee').value = state.simFeePct;

  const body = $('sim-body');
  body.replaceChildren();
  simRowRefs.clear();
  const { openLots } = ledger();
  const positions = openPositions(openLots, state.prices, state.simFx, state.options);
  $('sim-empty').hidden = positions.length > 0;
  $('sim-table').closest('.table-scroll').hidden = positions.length === 0;
  $('sim-suggest').disabled = positions.length === 0;
  $('sim-clear').disabled = positions.length === 0;

  for (const pos of positions) {
    const t = pos.ticker;
    const priceErr = el('span', { class: 'field-error', id: `sim-perr-${t}` });
    const sellErr = el('span', { class: 'field-error', id: `sim-serr-${t}` });
    const priceInput = el('input', {
      type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '현재가',
      'aria-label': `${t} 현재가 (USD)`, value: state.prices[t] !== undefined ? String(state.prices[t]) : '',
    });
    const sellInput = el('input', {
      type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0',
      'aria-label': `${t} 매도 수량`, value: state.sims[t] !== undefined ? String(state.sims[t]) : '',
    });
    const unreal = el('td', { class: 'num' });
    priceInput.addEventListener('input', () => onSimPrice(t, priceInput, priceErr));
    sellInput.addEventListener('input', () => onSimQty(t, pos.qty, sellInput, sellErr));
    simRowRefs.set(t, { unreal });
    body.append(
      el(
        'tr',
        {},
        el('th', { scope: 'row', text: t }),
        el('td', { class: 'num', text: fmtQty(pos.qty) }),
        el('td', { class: 'num', text: fmtWon(pos.costKRW) }),
        el('td', {}, priceInput, priceErr),
        unreal,
        el('td', {}, sellInput, sellErr),
      ),
    );
  }
  updateSimValues();
}

function setFieldError(node, input, message) {
  node.textContent = message || '';
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

function onSimPrice(ticker, input, errNode) {
  const raw = input.value.trim();
  if (raw === '') {
    delete state.prices[ticker];
    setFieldError(errNode, input, '');
  } else {
    const res = parseNumber(raw, { name: '현재가', decimals: 4, min: 0, minExclusive: true, max: LIM.maxPriceUSD });
    if (!res.ok) {
      setFieldError(errNode, input, res.error);
      return;
    }
    state.prices[ticker] = res.value;
    setFieldError(errNode, input, '');
  }
  savePrices();
  updateSimValues();
}

function onSimQty(ticker, held, input, errNode) {
  const raw = input.value.trim();
  if (raw === '') {
    delete state.sims[ticker];
    setFieldError(errNode, input, '');
  } else {
    const res = parseNumber(raw, { name: '매도 수량', decimals: LIM.qtyDecimals, min: 0, max: held });
    if (!res.ok) {
      setFieldError(errNode, input, res.error.replace(/이하로 입력하세요$/, '이하로 입력하세요 (보유)'));
      return;
    }
    if (res.value === 0) delete state.sims[ticker];
    else state.sims[ticker] = res.value;
    setFieldError(errNode, input, '');
  }
  updateSimValues();
}

// 입력 변화에 따라 값만 갱신합니다 (입력 중 포커스를 잃지 않도록 표 전체는 다시 그리지 않음).
function updateSimValues() {
  const { openLots } = ledger();
  const positions = openPositions(openLots, state.prices, state.simFx, state.options);
  for (const pos of positions) {
    const ref = simRowRefs.get(pos.ticker);
    if (!ref) continue;
    ref.unreal.textContent = pos.unrealizedGainKRW === null ? '현재가 입력' : fmtSigned(pos.unrealizedGainKRW);
  }
  renderSimHeadroom();
  renderSimResult();
  renderAi();
}

function renderSimHeadroom() {
  const { sales } = ledger();
  const s = summarizeYear(sales, thisYear());
  const box = $('sim-headroom');
  box.replaceChildren(
    el('p', {}, '올해 실현 순손익 ', el('strong', { text: fmtSigned(s.net) }), ' · 공제 여유 ', el('strong', { text: fmtWon(s.headroom) })),
    el('p', { class: 'hint', text: `현재 예상 세액 ${fmtWon(s.tax)}. 공제 여유는 이 금액까지 이익을 실현해도 세금이 0원이라는 뜻입니다.` }),
  );
}

function renderSimResult() {
  const box = $('sim-result');
  box.replaceChildren();
  const sells = Object.entries(state.sims).filter(([, q]) => q > 0);
  if (!sells.length) {
    box.append(el('h3', { text: '시뮬레이션 결과' }), el('p', { class: 'hint', text: '매도 수량을 입력하면 같은 선입선출 규칙으로 세금 변화를 계산합니다.' }));
    return;
  }
  const missing = sells.filter(([t]) => !(state.prices[t] > 0)).map(([t]) => t);
  if (missing.length) {
    box.append(el('h3', { text: '시뮬레이션 결과' }), el('p', { class: 'warn', text: `현재가를 입력하세요: ${missing.join(', ')}` }));
    return;
  }
  const { fxNow, feeRate } = currentSimInputs();
  const res = simulateSales({
    trades: state.trades,
    sells: sells.map(([t, q]) => ({ ticker: t, qty: q, priceUSD: state.prices[t] })),
    year: thisYear(),
    today: isoToday(),
    fxNow,
    feeRate,
    options: state.options,
  });
  box.append(el('h3', { text: '시뮬레이션 결과' }));
  if (!res.ok) {
    box.append(el('p', { class: 'warn', text: res.errors[0] }));
    return;
  }
  const d = res.taxDelta;
  const verdict = d < 0 ? `${fmtWon(-d)} 절세` : d > 0 ? `${fmtWon(d)} 증가` : '변화 없음';
  box.append(
    el(
      'div',
      { class: 'sim-cards' },
      el('div', { class: 'stat' }, el('p', { class: 'stat-label', text: '현재 예상 세액' }), el('p', { class: 'stat-value', text: fmtWon(res.before.tax) })),
      el('div', { class: 'stat' }, el('p', { class: 'stat-label', text: '매도 후 예상 세액' }), el('p', { class: 'stat-value', text: fmtWon(res.after.tax) })),
      el('div', { class: `stat stat-key ${d < 0 ? 'win' : ''}` }, el('p', { class: 'stat-label', text: '세금 차이' }), el('p', { class: 'stat-value', text: verdict })),
    ),
    el(
      'dl',
      { class: 'sale-figs' },
      el('div', {}, el('dt', { text: '이번 매도 손익' }), el('dd', { text: fmtSigned(res.simulatedGainKRW) })),
      el('div', {}, el('dt', { text: '올해 순손익' }), el('dd', { text: `${fmtSigned(res.before.net)} → ${fmtSigned(res.after.net)}` })),
      el('div', {}, el('dt', { text: '매도 후 과세표준' }), el('dd', { text: fmtWon(res.after.taxableBase) })),
    ),
  );
  if (res.after.highTierWarning) box.append(el('p', { class: 'warn', text: '과세표준이 3억 원을 넘습니다. 추가 세율 구간은 적용하지 않았습니다.' }));
  box.append(
    el('p', { class: 'hint', text: '이번 매도로 사용되는 lot (선입선출). 매도가와 취득가는 1원 단위 참고값이며, 세금은 연간 합계로 계산합니다.' }),
    el(
      'div',
      { class: 'table-scroll' },
      el(
        'table',
        { class: 'data compact' },
        el('thead', {}, el('tr', {},
          el('th', { scope: 'col', text: '종목' }),
          el('th', { scope: 'col', text: '매수일' }),
          el('th', { scope: 'col', class: 'num', text: '수량' }),
          el('th', { scope: 'col', class: 'num', text: '취득가(원)' }),
          el('th', { scope: 'col', class: 'num', text: '매도가(원)' }),
          el('th', { scope: 'col', class: 'num', text: '차익(원)' }),
        )),
        el(
          'tbody',
          {},
          res.simulatedSales.flatMap((sale) =>
            sale.slices.map((x) => {
              const proceeds = x.qty * sale.priceUSD * sale.fxRate;
              const cost = x.costKRW + (state.options.feeAsExpense ? x.buyFeeKRW + x.sellFeeKRW : 0);
              return el(
                'tr',
                {},
                el('td', { text: sale.ticker }),
                el('td', { text: x.buyDate }),
                el('td', { class: 'num', text: fmtQty(x.qty) }),
                el('td', { class: 'num', text: fmtWon(x.costKRW) }),
                el('td', { class: 'num', text: fmtWon(proceeds) }),
                el('td', { class: 'num', text: fmtSigned(proceeds - cost) }),
              );
            }),
          ),
        ),
      ),
    ),
  );
}

function bindSim() {
  $('sim-fx').addEventListener('input', (e) => {
    const res = parseNumber(e.target.value, { name: '환율', decimals: LIM.fxDecimals, min: LIM.minFxKRW, max: LIM.maxFxKRW });
    setFieldError($('e-simfx'), e.target, res.ok ? '' : res.error);
    if (!res.ok) return;
    state.simFx = res.value;
    saveSettings();
    updateSimValues();
  });
  $('sim-fee').addEventListener('input', (e) => {
    const res = parseNumber(e.target.value, { name: '수수료율', decimals: 3, min: 0, max: 10, allowEmpty: true });
    setFieldError($('e-simfee'), e.target, res.ok ? '' : res.error);
    if (!res.ok) return;
    state.simFeePct = e.target.value.trim();
    saveSettings();
    updateSimValues();
  });
  $('sim-suggest').addEventListener('click', () => {
    const { fxNow, feeRate } = currentSimInputs();
    const res = suggestHeadroom({ trades: state.trades, prices: state.prices, fxNow, feeRate, year: thisYear(), options: state.options });
    if (res.error) {
      window.alert(res.error);
      return;
    }
    const entries = Object.entries(res.quantities);
    if (!entries.length) {
      window.alert('제안할 이익 실현 수량이 없습니다. 현재가를 입력했는지, 공제 여유가 있는지 확인하세요.');
      return;
    }
    state.sims = Object.fromEntries(entries);
    renderSim();
  });
  $('sim-clear').addEventListener('click', () => {
    state.sims = {};
    renderSim();
  });
}

// ---------- 신고 준비 ----------

function renderFiling() {
  const f = filingInfo(isoToday());
  const card = $('dday-card');
  card.replaceChildren(
    el('p', { class: 'kicker', text: f.status === 'open' ? '신고 기간 중' : '다음 신고 기간' }),
    el('p', { class: 'dday-num', text: f.dDay === 0 ? 'D-day' : `D-${f.dDay}` }),
    el('p', { class: 'dday-label', text: `${f.start} ~ ${f.end} · 귀속 ${f.taxYear}년` }),
    el('p', { class: 'hint', text: '마감일 기준 남은 날수입니다. 신고 기간과 마감일은 constants.js에서 바꿀 수 있습니다.' }),
  );
  const list = $('checklist');
  list.replaceChildren();
  for (const item of CHECKLIST) {
    const id = `chk-${item.id}`;
    const box = el('input', { type: 'checkbox', id, ...(state.checklist[item.id] ? { checked: true } : {}) });
    box.addEventListener('change', () => {
      state.checklist[item.id] = box.checked;
      writeJson(KEY.checklist, state.checklist);
    });
    list.append(
      el('li', { class: 'check-item' }, box, el('label', { for: id }, el('strong', { text: item.title }), el('span', { class: 'hint', text: item.note }))),
    );
  }
  const done = CHECKLIST.filter((c) => state.checklist[c.id]).length;
  $('filing-csv-hint').textContent =
    `귀속 ${f.taxYear}년 매도 건을 내려받습니다. 준비 ${done}/${CHECKLIST.length}개 완료.`;
}

function bindFiling() {
  $('export-filing').addEventListener('click', () => {
    const f = filingInfo(isoToday());
    const s = summarizeYear(ledger().sales, f.taxYear);
    if (!s.saleCount) {
      window.alert(`${f.taxYear}년 귀속 매도 거래가 없습니다.`);
      return;
    }
    download(`gainlot-${f.taxYear}-신고용.csv`, 'text/csv;charset=utf-8', salesToCsv(s.sales));
  });
}

// ---------- AI 분석 ----------

function currentPayload() {
  const { sales, openLots } = ledger();
  const year = thisYear();
  const summary = summarizeYear(sales, year);
  const positions = openPositions(openLots, state.prices, state.simFx, state.options);
  const realizedByTicker = {};
  for (const s of summary.sales) realizedByTicker[s.ticker] = (realizedByTicker[s.ticker] || 0) + s.gainKRW;
  const payload = buildPayload({ summary, positions, fxNow: state.simFx, realizedByTicker });
  return { payload, summary, positions, realizedByTicker };
}

function renderAi() {
  const { payload } = currentPayload();
  $('ai-preview').textContent = JSON.stringify(payload, null, 2);
  $('ai-key-state').textContent = state.aiKey
    ? `API 키가 저장되어 있습니다 (끝 4자리: ${state.aiKey.slice(-4)}).`
    : 'API 키가 없습니다. 키 없이도 규칙 기반 분석을 볼 수 있습니다.';
  $('ai-run').disabled = !state.aiKey || state.aiBusy;
}

function renderAiResult(title, lines, note, error = '') {
  const box = $('ai-result');
  box.replaceChildren(el('h3', { text: title }));
  if (error) box.append(el('p', { class: 'warn', text: error }));
  for (const l of lines) box.append(el('p', { text: l }));
  if (note) box.append(el('p', { class: 'hint', text: note }));
}

function bindAi() {
  $('ai-key-save').addEventListener('click', () => {
    const input = $('ai-key');
    const value = input.value.trim();
    if (!isPlausibleKey(value)) {
      setFieldError($('e-aikey'), input, 'sk-ant- 로 시작하는 키 형식이 아닙니다.');
      return;
    }
    setFieldError($('e-aikey'), input, '');
    try {
      localStorage.setItem(KEY.aiKey, value);
    } catch {
      state.storageFailed = true;
      renderRulesBadge();
    }
    state.aiKey = value;
    input.value = '';
    renderAi();
  });
  $('ai-key-remove').addEventListener('click', () => {
    try {
      localStorage.removeItem(KEY.aiKey);
    } catch {
      state.storageFailed = true;
    }
    state.aiKey = '';
    renderAi();
  });
  $('ai-local').addEventListener('click', () => {
    const { summary, positions, realizedByTicker } = currentPayload();
    const lines = ruleBasedAnalysis({ summary, positions, fxNow: state.simFx, realizedByTicker });
    renderAiResult('규칙 기반 분석', lines, '네트워크를 쓰지 않고 이 화면의 숫자만으로 만든 문장입니다.');
  });
  $('ai-run').addEventListener('click', async () => {
    if (!state.aiKey || state.aiBusy) return;
    const { payload, summary, positions, realizedByTicker } = currentPayload();
    state.aiBusy = true;
    $('ai-run').disabled = true;
    $('ai-result').setAttribute('aria-busy', 'true');
    renderAiResult('AI 분석', ['분석하는 중입니다...'], '');
    const res = await sendToAnthropic({ key: state.aiKey, payload });
    state.aiBusy = false;
    $('ai-result').removeAttribute('aria-busy');
    if (res.ok) {
      const lines = res.text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
      renderAiResult('AI 분석', lines, 'AI가 생성한 참고 내용입니다. 세법 해석은 세무사에게 확인하세요.');
    } else {
      const lines = ruleBasedAnalysis({ summary, positions, fxNow: state.simFx, realizedByTicker });
      renderAiResult('규칙 기반 분석 (대체)', lines, '', `AI 분석을 가져오지 못했습니다. ${res.error}`);
    }
    renderAi();
  });
}

// ---------- 탭 ----------

function selectTab(name, focus = false) {
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const on = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on && focus) tab.focus();
    $(`panel-${tab.dataset.tab}`).hidden = !on;
  }
  if (name === 'ai') renderAi();
}

function bindTabs() {
  const tablist = document.querySelector('[role="tablist"]');
  tablist.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) selectTab(tab.dataset.tab);
  });
  tablist.addEventListener('keydown', (e) => {
    const tabs = [...tablist.querySelectorAll('[role="tab"]')];
    const i = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
    let next = null;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    e.preventDefault();
    selectTab(tabs[next].dataset.tab, true);
  });
}

// ---------- 시작 ----------

function bindTrades() {
  form.addEventListener('submit', submitTrade);
  $('trade-cancel').addEventListener('click', cancelEdit);
  $('csv-import').addEventListener('click', importCsv);
  $('csv-clear').addEventListener('click', () => {
    $('csv-text').value = '';
    $('csv-report').replaceChildren();
    $('csv-report').className = '';
  });
  $('csv-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 2000000) {
      showReport(['파일이 너무 큽니다 (2MB 제한).'], 'error');
      return;
    }
    $('csv-text').value = await file.text();
  });
}

function init() {
  loadAll();
  renderRulesBadge();
  renderOptions();
  setFormDefaults();
  bindTabs();
  bindTrades();
  bindBackup();
  bindYear();
  bindSim();
  bindFiling();
  bindAi();
  renderAll();
  selectTab('trades');
}

init();
