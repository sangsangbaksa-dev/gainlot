// 화면 제어. 계산은 logic.js와 ai.js에 있고, 여기서는 입력을 읽고 결과를 그립니다.
// 사용자 데이터는 textContent로만 넣습니다 (innerHTML 사용 안 함).
// 문구는 i18n.js의 t()로 만들고, 숫자와 날짜는 선택한 언어의 형식을 따릅니다.
import { TAX_CONSTANTS, DEFAULT_OPTIONS } from './constants.js';
import {
  newId, isoToday, parseNumber, validateTrade, computeLedger, summarizeYear, summarizeByAccount, summarizeByTicker, tickerSummaryToCsv,
  compareYears, accountsOf, listYears, openPositions, simulateSales, suggestHeadroom, filingInfo,
  parseTradeCsv, salesToCsv, makeBackup, parseBackup, sampleTrades, DEFAULT_ACCOUNT, accountLabel,
} from './logic.js';
import { buildPayload, ruleBasedAnalysis, sendToAnthropic, isPlausibleKey } from './ai.js';
import {
  t, setLang, getLang, detectLang, readSavedLang, saveLang, applyI18n, LANGS, fmtNumber, fmtDate,
} from './i18n.js';

const KEY = {
  trades: 'gainlot-trades',
  settings: 'gainlot-settings',
  checklist: 'gainlot-checklist',
  prices: 'gainlot-prices',
  aiKey: 'gainlot-ai-key',
};
const LIM = TAX_CONSTANTS.limits;
const CONFIRM_KEY = 'needsCheck';
const CHECKLIST = [
  { id: 'stmt', title: 'chkStmtT', note: 'chkStmtN' },
  { id: 'fx', title: 'chkFxT', note: 'chkFxN' },
  { id: 'fee', title: 'chkFeeT', note: 'chkFeeN' },
  { id: 'transfer', title: 'chkTransferT', note: 'chkTransferN' },
  { id: 'other', title: 'chkOtherT', note: 'chkOtherN' },
  { id: 'loss', title: 'chkLossT', note: 'chkLossN' },
  { id: 'account', title: 'chkAccountT', note: 'chkAccountN' },
  { id: 'csv', title: 'chkCsvT', note: 'chkCsvN' },
];

const state = {
  trades: [],
  options: { ...DEFAULT_OPTIONS },
  lastFx: TAX_CONSTANTS.defaultFxKRW,
  lastAccount: '',
  simFx: TAX_CONSTANTS.defaultFxKRW,
  simFeePct: '',
  yearView: 'combined',
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
const CONFIRM = () => t(CONFIRM_KEY);
const thisYear = () => Number(isoToday().slice(0, 4));
const fmtWon = (n) => t('wonAmt', { n: fmtNumber(Math.round(n) || 0) });
const fmtSigned = (n) => {
  const v = Math.round(n) || 0;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${t('wonAmt', { n: fmtNumber(Math.abs(v)) })}`;
};
const fmtQty = (n) => fmtNumber(n, { maximumFractionDigits: 6 });
const fmtUsd = (n) => fmtNumber(n, { maximumFractionDigits: 4 });
const fmtRate = (n) => fmtNumber(n, { maximumFractionDigits: 2 });
const posKey = (account, ticker) => JSON.stringify([account, ticker]);
const accountOf = (tr) => tr.account || DEFAULT_ACCOUNT;
const sideLabel = (side) => (side === 'BUY' ? t('sideBuy') : t('sideSell'));

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

// 넓은 표를 감싸는 스크롤 영역. 키보드로 포커스해서 좌우로 밀 수 있게 합니다.
function scrollRegion(label, table) {
  return el('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': label }, table);
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

function tradeKey(tr) {
  return [accountOf(tr), tr.date, tr.ticker, tr.side, tr.qty, tr.price, tr.fee, tr.fx].join('|');
}

function nextSeq() {
  return state.trades.reduce((m, tr) => Math.max(m, tr.seq || 0), 0) + 1;
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
    if (typeof settings.lastAccount === 'string') state.lastAccount = settings.lastAccount.slice(0, 20);
    if (settings.yearView === 'split') state.yearView = 'split';
  }
  const checklist = readJson(KEY.checklist, {});
  if (checklist && typeof checklist === 'object') state.checklist = checklist;
  const prices = readJson(KEY.prices, {});
  if (prices && typeof prices === 'object') {
    for (const [tk, v] of Object.entries(prices)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) state.prices[tk] = v;
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
        ...(raw.sample === true ? { sample: true } : {}),
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
    lastAccount: state.lastAccount,
    yearView: state.yearView,
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
  renderSampleBanner();
  renderAccountOptions();
  renderTrades();
  renderYear();
  renderSim();
  renderFiling();
  renderAi();
}

function appliesTo() { return t('appliesToText', { y: TAX_CONSTANTS.taxYear, f: TAX_CONSTANTS.taxYear + 1 }); }
function asOfText() { return t('asOfText', { d: '2026-11-06' }); }

function renderRulesBadge() {
  const { basicDeduction, totalRate } = TAX_CONSTANTS;
  $('rules-badge').textContent = t('rulesBadge', {
    applies: appliesTo(), asOf: asOfText(), ded: fmtNumber(basicDeduction), rate: Math.round(totalRate * 100), check: CONFIRM(),
  });
  $('fx-note').textContent = t('fxBasisNote');
  $('storage-notice').hidden = !state.storageFailed;
  if (state.storageFailed) {
    $('storage-notice').textContent = t('storageWarn');
  }
}

function renderLedgerAlert() {
  const { errors } = ledger();
  const box = $('ledger-alert');
  box.replaceChildren();
  box.hidden = errors.length === 0;
  if (errors.length) {
    box.append(
      el('strong', { text: t('ledgerBroken') }),
      el('p', { class: 'hint', text: t('ledgerBrokenHint') }),
    );
    for (const e of errors.slice(0, 5)) box.append(el('p', { text: e.message }));
    if (errors.length > 5) box.append(el('p', { text: t('moreErrors', { n: errors.length - 5 }) }));
  }
}

function renderSampleBanner() {
  const has = state.trades.some((tr) => tr.sample);
  $('sample-banner').hidden = !has;
}

// 계좌 이름 후보를 입력란과 가져오기 칸에 채웁니다.
function renderAccountOptions() {
  const list = $('account-options');
  list.replaceChildren(...accountsOf(state.trades).map((a) => el('option', { value: a })));
}

// ---------- 거래 입력 ----------

const form = $('trade-form');

function setFormDefaults() {
  form.elements.date.value = isoToday();
  form.elements.date.max = isoToday();
  form.elements.date.min = LIM.minDate;
  form.elements.fx.value = String(state.lastFx);
  form.elements.account.value = state.lastAccount;
}

function clearFormErrors() {
  for (const id of ['date', 'ticker', 'side', 'qty', 'price', 'fee', 'fx', 'account']) {
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
    account: f.account.value,
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
  $('trade-form-title').textContent = t('tradeFormTitle');
  $('trade-submit').textContent = t('tradeAdd');
  $('trade-cancel').hidden = true;
  clearFormErrors();
}

function startEdit(id) {
  const tr = state.trades.find((x) => x.id === id);
  if (!tr) return;
  const f = form.elements;
  f.date.value = tr.date;
  f.ticker.value = tr.ticker;
  f.side.value = tr.side;
  f.qty.value = String(tr.qty);
  f.price.value = String(tr.price);
  f.fee.value = String(tr.fee);
  f.fx.value = String(tr.fx);
  f.account.value = accountOf(tr);
  state.editingId = id;
  clearFormErrors();
  $('trade-form-title').textContent = t('tradeEditTitle');
  $('trade-submit').textContent = t('tradeSaveEdit');
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
    next = state.trades.map((tr) => (tr.id === state.editingId ? { ...tr, ...res.trade } : tr));
  } else {
    next = [...state.trades, { id: newId(), ...res.trade, seq: nextSeq() }];
  }
  const out = commitTrades(next);
  if (!out.ok) {
    $('trade-form-error').textContent = out.message;
    return;
  }
  state.lastFx = res.trade.fx;
  state.lastAccount = res.trade.account === DEFAULT_ACCOUNT ? '' : res.trade.account;
  saveSettings();
  if (state.editingId) cancelEdit();
  else {
    resetTradeFormKeepContext();
    form.elements.qty.focus();
  }
}

function removeTrade(id) {
  const tr = state.trades.find((x) => x.id === id);
  if (!tr) return;
  if (!window.confirm(t('confirmRemoveTrade', { date: fmtDate(tr.date), ticker: tr.ticker, side: sideLabel(tr.side), account: accountLabel(accountOf(tr)) }))) return;
  const out = commitTrades(state.trades.filter((x) => x.id !== id));
  if (!out.ok) window.alert(t('alertBreaks', { msg: out.message }));
  if (state.editingId === id) cancelEdit();
}

function renderTrades() {
  const body = $('trade-body');
  body.replaceChildren();
  const list = state.trades.slice().sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : b.seq - a.seq));
  $('trade-count').textContent = list.length ? t('countTrades', { n: list.length }) : '';
  $('trade-empty').hidden = list.length > 0;
  $('trade-table-wrap').hidden = list.length === 0;
  for (const tr of list) {
    body.append(
      el(
        'tr',
        {},
        el('td', { text: fmtDate(tr.date) }),
        el('td', {}, el('span', { text: accountLabel(accountOf(tr)) }), tr.sample ? el('span', { class: 'tag sample', text: t('sampleTag') }) : null),
        el('td', { text: tr.ticker }),
        el('td', {}, el('span', { class: tr.side === 'BUY' ? 'tag buy' : 'tag sell', text: sideLabel(tr.side) })),
        el('td', { class: 'num', text: fmtQty(tr.qty) }),
        el('td', { class: 'num', text: fmtUsd(tr.price) }),
        el('td', { class: 'num', text: fmtUsd(tr.fee) }),
        el('td', { class: 'num', text: fmtRate(tr.fx) }),
        el('td', { class: 'num', text: fmtWon(tr.qty * tr.price * tr.fx) }),
        el(
          'td',
          { class: 'row-actions' },
          el('button', { type: 'button', class: 'btn btn-ghost btn-xs', 'aria-label': t('ariaEditTrade', { date: fmtDate(tr.date), ticker: tr.ticker, account: accountLabel(accountOf(tr)) }), text: t('editBtn'), onclick: () => startEdit(tr.id) }),
          el('button', { type: 'button', class: 'btn btn-danger-ghost btn-xs', 'aria-label': t('ariaDelTrade', { date: fmtDate(tr.date), ticker: tr.ticker, account: accountLabel(accountOf(tr)) }), text: t('deleteBtn'), onclick: () => removeTrade(tr.id) }),
        ),
      ),
    );
  }
  const emptySample = $('trade-empty-sample');
  if (emptySample) emptySample.hidden = list.length > 0;
}

// ---------- 예시 데이터 ----------

function loadSample() {
  if (state.trades.length) {
    window.alert(t('alertSampleExists'));
    return;
  }
  const added = sampleTrades().map((tr, i) => ({ id: newId(), ...tr, seq: i + 1, sample: true }));
  const out = commitTrades(added);
  if (!out.ok) {
    window.alert(t('alertSampleFail', { msg: out.message }));
    return;
  }
  state.year = null;
  renderAll();
}

function clearSample() {
  const n = state.trades.filter((tr) => tr.sample).length;
  if (!n) return;
  if (!window.confirm(t('confirmClearSample', { n }))) return;
  const out = commitTrades(state.trades.filter((tr) => !tr.sample));
  if (!out.ok) window.alert(t('alertSampleBreaks', { msg: out.message }));
}

// ---------- CSV / 백업 ----------

function showReport(lines, tone = 'info', extra = null) {
  const box = $('csv-report');
  box.replaceChildren();
  box.className = tone;
  for (const l of lines) box.append(el('p', { text: l }));
  if (extra) box.append(extra);
}

function importCsv() {
  const accountInput = $('csv-account').value.trim();
  const res = parseTradeCsv($('csv-text').value, { today: isoToday(), account: accountInput || undefined });
  if (res.fatal) {
    showReport([t('importNotDone', { msg: res.fatal })], 'error');
    return;
  }
  const existing = new Set(state.trades.map(tradeKey));
  let seq = nextSeq();
  const added = [];
  const skipped = [];
  let dup = 0;
  for (const row of res.rows) {
    if (!row.ok) {
      skipped.push({ line: row.line, text: row.errors.map((e) => e.message).join(' / ') });
      continue;
    }
    if (existing.has(tradeKey(row.trade))) {
      dup += 1;
      continue;
    }
    existing.add(tradeKey(row.trade));
    added.push({ id: newId(), ...row.trade, seq: seq++ });
  }
  const merged = state.trades.concat(added);
  const check = computeLedger(merged, state.options);
  if (check.errors.length) {
    showReport([t('importCancelled'), ...check.errors.slice(0, 5).map((e) => e.message)], 'error');
    return;
  }
  if (added.length) {
    state.trades = merged;
    const last = added[added.length - 1].account;
    state.lastAccount = last === DEFAULT_ACCOUNT ? '' : last;
    saveTrades();
    saveSettings();
    renderAll();
  }
  const lines = [
    t('importDone', { n: added.length, dup }),
    t('importMapping', { map: Object.entries(res.mapping || {}).map(([f, h]) => `${h}→${f}`).join(', ') }),
  ];
  let extra = null;
  if (skipped.length) {
    lines.push(t('importSkipped', { n: skipped.length }));
    extra = el(
      'div',
      { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': t('importErrRegion') },
      el(
        'table',
        { class: 'data compact' },
        el('caption', { class: 'sr-only', text: t('importErrCaption') }),
        el('thead', {}, el('tr', {}, el('th', { scope: 'col', text: t('colLine') }), el('th', { scope: 'col', text: t('colReason') }))),
        el('tbody', {}, skipped.slice(0, 50).map((s) => el('tr', {}, el('td', { class: 'num', text: t('rowN', { n: s.line }) }), el('td', { text: s.text })))),
      ),
    );
    if (skipped.length > 50) lines.push(t('importMore', { n: skipped.length - 50 }));
  }
  showReport(lines, skipped.length || dup ? 'warn' : 'ok', extra);
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
      $('backup-error').textContent = t('backupTooBig');
      return;
    }
    const res = parseBackup(await file.text(), { today: isoToday() });
    if (!res.ok) {
      $('backup-error').textContent = t('backupNotLoaded', { msg: res.errors.slice(0, 3).join(' ') });
      return;
    }
    if (!window.confirm(t('confirmRestore', { cur: state.trades.length, n: res.trades.length }))) return;
    state.trades = res.trades;
    state.options = res.options;
    saveTrades();
    saveSettings();
    renderAll();
    renderOptions();
  });
  $('clear-all').addEventListener('click', () => {
    if (!state.trades.length) return;
    if (!window.confirm(t('confirmClearAll'))) return;
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
  $('year-view').value = state.yearView;
}

function renderYear() {
  const years = listYears(state.trades, state.options);
  const select = $('year-select');
  select.replaceChildren();
  const list = years.length ? years : [thisYear()];
  for (const y of list.slice().reverse()) select.append(el('option', { value: y, text: t('taxYearOpt', { y }) }));
  if (!state.year || !list.includes(state.year)) state.year = list[list.length - 1];
  select.value = String(state.year);

  const { sales } = ledger();
  const s = summarizeYear(sales, state.year);
  const grid = $('year-summary');
  grid.replaceChildren();
  const card = (label, value, note, extra = '') =>
    el('div', { class: `stat ${extra}` }, el('p', { class: 'stat-label', text: label }), el('p', { class: 'stat-value', text: value }), note ? el('p', { class: 'hint', text: note }) : null);
  grid.append(
    card(t('stTotalGain'), fmtWon(s.totalGain), t('stTotalGainN', { n: s.saleCount })),
    card(t('stTotalLoss'), fmtWon(s.totalLoss), t('stTotalLossN')),
    card(t('stNet'), fmtSigned(s.net), t('stNetN', { check: CONFIRM() })),
    card(t('stDeduction'), fmtWon(s.deduction), t('stDeductionN', { check: CONFIRM() })),
    card(t('stBase'), fmtWon(s.taxableBase), t('stBaseN')),
    card(t('stTax', { r: Math.round(s.rate * 100) }), fmtWon(s.tax), t('stTaxN', { check: CONFIRM() }), 'stat-key'),
    card(t('stHeadroom'), fmtWon(s.headroom), t('stHeadroomN', { check: CONFIRM() })),
  );
  const notes = $('year-notes');
  notes.textContent = s.highTierWarning
    ? t('highTierWarn')
    : t('yearNotes', { y: state.year, check: CONFIRM() });

  renderCompare(sales);
  renderAccountSplit(sales);
  renderTicker(sales);

  $('sale-count').textContent = s.saleCount ? t('countSales', { n: s.saleCount }) : '';
  $('sale-empty').hidden = s.saleCount > 0;
  const emptySample = $('sale-empty-sample');
  if (emptySample) emptySample.hidden = state.trades.length > 0;
  const list2 = $('sale-list');
  list2.replaceChildren();
  for (const sale of s.sales) list2.append(saleDetails(sale));
}

// 연도별 비교표. 연도 칸의 버튼으로 해당 연도를 엽니다.
function renderCompare(sales) {
  const years = listYears(state.trades, state.options);
  const body = $('compare-body');
  body.replaceChildren();
  $('compare-empty').hidden = years.length > 0;
  $('compare-wrap').hidden = years.length === 0;
  if (!years.length) return;
  for (const r of compareYears(sales, years, TAX_CONSTANTS)) {
    const current = r.year === state.year;
    body.append(
      el(
        'tr',
        { class: current ? 'current' : '' },
        el('th', { scope: 'row' }, el('button', { type: 'button', class: 'btn btn-ghost btn-xs year-pick', 'aria-pressed': String(current), text: t('yearLabel', { y: r.year }), onclick: () => { state.year = r.year; renderYear(); } })),
        el('td', { class: 'num', text: t('countSales', { n: r.saleCount }) }),
        el('td', { class: 'num', text: fmtWon(r.totalGain) }),
        el('td', { class: 'num', text: fmtWon(r.totalLoss) }),
        el('td', { class: 'num', text: fmtSigned(r.net) }),
        el('td', { class: 'num', text: fmtWon(r.taxableBase) }),
        el('td', { class: 'num', text: fmtWon(r.tax) }),
        el('td', { class: 'num', text: fmtWon(r.headroom) }),
      ),
    );
  }
}

// 종목별 손익 표. 계좌 구분 없이 종목 하나에 한 줄입니다.
function renderTicker(sales) {
  const rows = summarizeByTicker(sales, state.year);
  const body = $('ticker-body');
  body.replaceChildren();
  $('ticker-empty').hidden = rows.length > 0;
  $('ticker-wrap').hidden = rows.length === 0;
  $('export-ticker').disabled = rows.length === 0;
  for (const r of rows) {
    body.append(
      el(
        'tr',
        {},
        el('th', { scope: 'row', text: r.ticker }),
        el('td', { class: 'num', text: t('countSales', { n: r.saleCount }) }),
        el('td', { class: 'num', text: fmtWon(r.totalGain) }),
        el('td', { class: 'num', text: fmtWon(r.totalLoss) }),
        el('td', { class: 'num', text: fmtSigned(r.net) }),
      ),
    );
  }
}

// 계좌별 분리 보기: 손익만 나눕니다. 세액은 합산 한 번으로만 계산합니다.
function renderAccountSplit(sales) {
  const split = state.yearView === 'split';
  const box = $('account-split');
  box.hidden = !split;
  if (!split) return;
  const rows = summarizeByAccount(sales, state.year);
  const body = $('account-split-body');
  body.replaceChildren();
  $('account-split-empty').hidden = rows.length > 0;
  $('account-split-wrap').hidden = rows.length === 0;
  for (const r of rows) {
    body.append(
      el(
        'tr',
        {},
        el('th', { scope: 'row', text: accountLabel(r.account) }),
        el('td', { class: 'num', text: t('countSales', { n: r.saleCount }) }),
        el('td', { class: 'num', text: fmtWon(r.totalGain) }),
        el('td', { class: 'num', text: fmtWon(r.totalLoss) }),
        el('td', { class: 'num', text: fmtSigned(r.net) }),
      ),
    );
  }
}

function saleDetails(sale) {
  const gainClass = sale.gainKRW < 0 ? 'neg' : sale.gainKRW > 0 ? 'pos' : '';
  const rows = sale.slices.map((x) =>
    el(
      'tr',
      {},
      el('td', { text: fmtDate(x.buyDate) }),
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
      el('span', { class: 'sale-title', text: t('saleTitle', { date: fmtDate(sale.date), ticker: sale.ticker, qty: fmtQty(sale.qty), account: accountLabel(sale.account || DEFAULT_ACCOUNT) }) }),
      el('span', { class: `sale-gain ${gainClass}`, text: fmtSigned(sale.gainKRW) }),
    ),
    el(
      'dl',
      { class: 'sale-figs' },
      el('div', {}, el('dt', { text: t('figProceeds') }), el('dd', { text: fmtWon(sale.proceedsKRW) })),
      el('div', {}, el('dt', { text: t('figCost') }), el('dd', { text: fmtWon(sale.costKRW) })),
      el('div', {}, el('dt', { text: t('figExpense') }), el('dd', { text: fmtWon(sale.expenseKRW) })),
      el('div', {}, el('dt', { text: t('figPriceFx') }), el('dd', { text: t('figPriceFxVal', { p: fmtUsd(sale.priceUSD), fx: fmtRate(sale.fxRate) }) })),
    ),
    el('p', { class: 'hint', text: t('lotHint') }),
    scrollRegion(
      t('lotRegion', { ticker: sale.ticker }),
      el(
        'table',
        { class: 'data compact' },
        el('caption', { class: 'sr-only', text: t('lotCaption', { date: fmtDate(sale.date), ticker: sale.ticker }) }),
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', { scope: 'col', text: t('colBuyDate') }),
            el('th', { scope: 'col', class: 'num', text: t('colQty') }),
            el('th', { scope: 'col', class: 'num', text: t('colBuyPrice') }),
            el('th', { scope: 'col', class: 'num', text: t('colBuyFx') }),
            el('th', { scope: 'col', class: 'num', text: t('colCostWon') }),
            el('th', { scope: 'col', class: 'num', text: t('colFeeWon') }),
          ),
        ),
        el('tbody', {}, rows),
      ),
    ),
  );
}

// 인쇄용 리포트: 화면에서는 숨기고, 인쇄할 때만 보입니다.
function buildPrintReport() {
  const { sales } = ledger();
  const s = summarizeYear(sales, state.year);
  const years = listYears(state.trades, state.options);
  const f = filingInfo(isoToday());
  const table = (caption, head, rows) =>
    el('table', { class: 'data' }, el('caption', { text: caption }), el('thead', {}, el('tr', {}, head.map((h, i) => el('th', { scope: 'col', class: i > 0 && h.num ? 'num' : '', text: h.label })))), el('tbody', {}, rows));
  const cell = (v, num) => el('td', { class: num ? 'num' : '', text: v });

  const root = $('print-area');
  root.replaceChildren(
    el('header', { class: 'print-head' },
      el('h1', { text: t('prTitle', { y: state.year }) }),
      el('p', { text: t('prMeta', { date: fmtDate(isoToday()), start: fmtDate(f.start), end: fmtDate(f.end), check: CONFIRM() }) }),
      el('p', { class: 'print-warn', text: t('prWarn') }),
    ),
    el('section', {},
      el('h2', { text: t('prConstants') }),
      el('ul', {},
        el('li', { text: t('prDed', { ded: fmtNumber(TAX_CONSTANTS.basicDeduction), check: CONFIRM() }) }),
        el('li', { text: t('prRate', { r: Math.round(TAX_CONSTANTS.totalRate * 100), check: CONFIRM() }) }),
        el('li', { text: t('prLoss', { check: CONFIRM() }) }),
        el('li', { text: t('prFx') }),
        el('li', { text: t('prFee', { v: state.options.feeAsExpense ? t('feeExpenseOn') : t('feeExpenseOff'), check: CONFIRM() }) }),
        el('li', { text: t('prBasis', { applies: appliesTo(), asOf: asOfText() }) }),
      ),
    ),
    el('section', {},
      el('h2', { text: t('prSummaryH') }),
      table(t('prSummaryCap'), [{ label: t('colItem') }, { label: t('colAmount'), num: true }], [
        el('tr', {}, cell(t('stTotalGain')), cell(fmtWon(s.totalGain), true)),
        el('tr', {}, cell(t('stTotalLoss')), cell(fmtWon(s.totalLoss), true)),
        el('tr', {}, cell(t('stNet')), cell(fmtSigned(s.net), true)),
        el('tr', {}, cell(t('stDeduction')), cell(fmtWon(s.deduction), true)),
        el('tr', {}, cell(t('stBase')), cell(fmtWon(s.taxableBase), true)),
        el('tr', {}, cell(t('stTax', { r: Math.round(s.rate * 100) })), cell(fmtWon(s.tax), true)),
        el('tr', {}, cell(t('stHeadroom')), cell(fmtWon(s.headroom), true)),
      ]),
    ),
    el('section', {},
      el('h2', { text: t('prAccountH') }),
      table(t('prAccountCap'), [{ label: t('colAccount') }, { label: t('colSalesCount'), num: true }, { label: t('colTotalGain'), num: true }, { label: t('colTotalLoss'), num: true }, { label: t('colNet'), num: true }],
        summarizeByAccount(sales, state.year).map((r) => el('tr', {}, cell(accountLabel(r.account)), cell(t('countSales', { n: r.saleCount }), true), cell(fmtWon(r.totalGain), true), cell(fmtWon(r.totalLoss), true), cell(fmtSigned(r.net), true)))),
    ),
    el('section', {},
      el('h2', { text: t('prCompareH') }),
      table(t('prCompareCap'), [{ label: t('colYear') }, { label: t('colNet'), num: true }, { label: t('colBase'), num: true }, { label: t('colTax'), num: true }, { label: t('colHeadroom'), num: true }],
        compareYears(sales, years, TAX_CONSTANTS).map((r) => el('tr', {}, cell(t('yearLabel', { y: r.year })), cell(fmtSigned(r.net), true), cell(fmtWon(r.taxableBase), true), cell(fmtWon(r.tax), true), cell(fmtWon(r.headroom), true)))),
    ),
    el('section', {},
      el('h2', { text: t('prSalesH', { y: state.year }) }),
      s.sales.length
        ? table(t('prSalesCap'), [{ label: t('colSaleDate') }, { label: t('colAccount') }, { label: t('colTicker') }, { label: t('colQty'), num: true }, { label: t('colProceeds'), num: true }, { label: t('colCost'), num: true }, { label: t('colExpense'), num: true }, { label: t('colGain'), num: true }],
          s.sales.map((x) => el('tr', {}, cell(fmtDate(x.date)), cell(accountLabel(accountOf(x))), cell(x.ticker), cell(fmtQty(x.qty), true), cell(fmtWon(x.proceedsKRW), true), cell(fmtWon(x.costKRW), true), cell(fmtWon(x.expenseKRW), true), cell(fmtSigned(x.gainKRW), true))))
        : el('p', { text: t('noSalesYear') }),
    ),
  );
  return root;
}

function printYearReport() {
  buildPrintReport();
  window.print();
}

function bindYear() {
  $('year-select').addEventListener('change', (e) => {
    state.year = Number(e.target.value);
    renderYear();
  });
  $('year-view').addEventListener('change', (e) => {
    state.yearView = e.target.value === 'split' ? 'split' : 'combined';
    saveSettings();
    renderYear();
  });
  $('opt-fee').addEventListener('change', (e) => setOption('feeAsExpense', e.target.checked));
  $('opt-sameday').addEventListener('change', (e) => setOption('sameDayBuyFirst', e.target.checked));
  $('export-year').addEventListener('click', () => {
    const { sales } = ledger();
    const s = summarizeYear(sales, state.year);
    if (!s.saleCount) {
      window.alert(t('alertNoSalesYear', { y: state.year }));
      return;
    }
    download(`gainlot-${state.year}-sales.csv`, 'text/csv;charset=utf-8', salesToCsv(s.sales));
  });
  $('export-ticker').addEventListener('click', () => {
    const { sales } = ledger();
    const rows = summarizeByTicker(sales, state.year);
    if (!rows.length) {
      window.alert(t('alertNoSalesYear', { y: state.year }));
      return;
    }
    download(`gainlot-${state.year}-tickers.csv`, 'text/csv;charset=utf-8', tickerSummaryToCsv(rows));
  });
  $('print-year').addEventListener('click', printYearReport);
}

function setOption(key, value) {
  const next = { ...state.options, [key]: value };
  const check = computeLedger(state.trades, next);
  if (check.errors.length) {
    window.alert(t('alertOptionBreaks', { msg: check.errors[0].message }));
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
  const feeRes = parseNumber(state.simFeePct, { name: t('fieldSimFee'), decimals: 3, min: 0, max: 10, allowEmpty: true });
  return {
    fxNow: state.simFx,
    feeRate: feeRes.ok ? feeRes.value / 100 : 0,
  };
}

function renderSim() {
  const year = thisYear();
  $('sim-year').textContent = t('simYearLabel', { y: year });
  if (document.activeElement !== $('sim-fx')) $('sim-fx').value = String(state.simFx);
  if (document.activeElement !== $('sim-fee')) $('sim-fee').value = state.simFeePct;

  const { openLots } = ledger();
  const positions = openPositions(openLots, state.prices, state.simFx, state.options);
  renderSimPrices(positions);

  const body = $('sim-body');
  body.replaceChildren();
  simRowRefs.clear();
  $('sim-empty').hidden = positions.length > 0;
  $('sim-table').closest('.table-scroll').hidden = positions.length === 0;
  $('sim-suggest').disabled = positions.length === 0;
  $('sim-clear').disabled = positions.length === 0;

  for (const pos of positions) {
    const tk = pos.ticker;
    const key = posKey(pos.account, tk);
    const sellErr = el('span', { class: 'field-error', id: `sim-serr-${simId(key)}` });
    const sellInput = el('input', {
      type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0',
      'aria-label': t('ariaSimQty', { account: accountLabel(pos.account), ticker: tk }), value: state.sims[key] !== undefined ? String(state.sims[key]) : '',
    });
    const unreal = el('td', { class: 'num' });
    sellInput.addEventListener('input', () => onSimQty(key, pos.qty, sellInput, sellErr));
    simRowRefs.set(key, { unreal, ticker: tk });
    body.append(
      el(
        'tr',
        {},
        el('th', { scope: 'row', text: accountLabel(pos.account) }),
        el('td', { text: tk }),
        el('td', { class: 'num', text: fmtQty(pos.qty) }),
        el('td', { class: 'num', text: fmtWon(pos.costKRW) }),
        unreal,
        el('td', {}, sellInput, sellErr),
      ),
    );
  }
  updateSimValues();
}

// 종목별 현재가는 계좌와 상관없이 한 번만 입력합니다.
function renderSimPrices(positions) {
  const box = $('sim-prices');
  box.replaceChildren();
  const tickers = [...new Set(positions.map((p) => p.ticker))];
  box.hidden = tickers.length === 0;
  for (const tk of tickers) {
    const id = `sim-price-${simId(tk)}`;
    const err = el('span', { class: 'field-error', id: `sim-perr-${simId(tk)}` });
    const input = el('input', {
      type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: t('pricePh'), id,
      'aria-label': t('ariaPrice', { ticker: tk }), value: state.prices[tk] !== undefined ? String(state.prices[tk]) : '',
    });
    input.addEventListener('input', () => onSimPrice(tk, input, err));
    box.append(el('div', { class: 'price-field' }, el('label', { for: id, text: tk }), input, err));
  }
}

// DOM id에 안전하게 쓰려고 간단한 해시를 씁니다.
function simId(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
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
    const res = parseNumber(raw, { name: t('fieldPriceNow'), decimals: 4, min: 0, minExclusive: true, max: LIM.maxPriceUSD });
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

function onSimQty(key, held, input, errNode) {
  const raw = input.value.trim();
  if (raw === '') {
    delete state.sims[key];
    setFieldError(errNode, input, '');
  } else {
    const res = parseNumber(raw, { name: t('fieldSellQty'), decimals: LIM.qtyDecimals, min: 0, max: held });
    if (!res.ok) {
      setFieldError(errNode, input, `${res.error} ${t('heldAcct', { q: fmtQty(held) })}`);
      return;
    }
    if (res.value === 0) delete state.sims[key];
    else state.sims[key] = res.value;
    setFieldError(errNode, input, '');
  }
  updateSimValues();
}

// 입력 변화에 따라 값만 갱신합니다 (입력 중 포커스를 잃지 않도록 표 전체는 다시 그리지 않음).
function updateSimValues() {
  const { openLots } = ledger();
  const positions = openPositions(openLots, state.prices, state.simFx, state.options);
  for (const pos of positions) {
    const ref = simRowRefs.get(posKey(pos.account, pos.ticker));
    if (!ref) continue;
    ref.unreal.textContent = pos.unrealizedGainKRW === null ? t('enterPrice') : fmtSigned(pos.unrealizedGainKRW);
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
    el('p', {}, t('headNet'), ' ', el('strong', { text: fmtSigned(s.net) }), ' · ', t('headRoom'), ' ', el('strong', { text: fmtWon(s.headroom) })),
    el('p', { class: 'hint', text: t('headNote', { tax: fmtWon(s.tax), check: CONFIRM() }) }),
  );
}

function sellsFromState() {
  return Object.entries(state.sims)
    .filter(([, q]) => q > 0)
    .map(([key, qty]) => {
      const [account, ticker] = JSON.parse(key);
      return { account, ticker, qty, priceUSD: state.prices[ticker] };
    });
}

function renderSimResult() {
  const box = $('sim-result');
  box.replaceChildren();
  const sells = sellsFromState();
  if (!sells.length) {
    box.append(el('h3', { text: t('simResultH') }), el('p', { class: 'hint', text: t('simResultIdle') }));
    return;
  }
  const missing = [...new Set(sells.filter((s) => !(s.priceUSD > 0)).map((s) => s.ticker))];
  if (missing.length) {
    box.append(el('h3', { text: t('simResultH') }), el('p', { class: 'warn', text: t('simNeedPrice', { list: missing.join(', ') }) }));
    return;
  }
  const { fxNow, feeRate } = currentSimInputs();
  const res = simulateSales({
    trades: state.trades,
    sells,
    year: thisYear(),
    today: isoToday(),
    fxNow,
    feeRate,
    options: state.options,
  });
  box.append(el('h3', { text: t('simResultH') }));
  if (!res.ok) {
    box.append(el('p', { class: 'warn', text: res.errors[0] }));
    return;
  }
  const d = res.taxDelta;
  const verdict = d < 0 ? t('saved', { amt: fmtWon(-d) }) : d > 0 ? t('raised', { amt: fmtWon(d) }) : t('noChange');
  box.append(
    el(
      'div',
      { class: 'sim-cards' },
      el('div', { class: 'stat' }, el('p', { class: 'stat-label', text: t('simTaxNow') }), el('p', { class: 'stat-value', text: fmtWon(res.before.tax) })),
      el('div', { class: 'stat' }, el('p', { class: 'stat-label', text: t('simTaxAfter') }), el('p', { class: 'stat-value', text: fmtWon(res.after.tax) })),
      el('div', { class: `stat stat-key ${d < 0 ? 'win' : ''}` }, el('p', { class: 'stat-label', text: t('simDiff') }), el('p', { class: 'stat-value', text: verdict })),
    ),
    el(
      'dl',
      { class: 'sale-figs' },
      el('div', {}, el('dt', { text: t('simGain') }), el('dd', { text: fmtSigned(res.simulatedGainKRW) })),
      el('div', {}, el('dt', { text: t('simNetYear') }), el('dd', { text: `${fmtSigned(res.before.net)} → ${fmtSigned(res.after.net)}` })),
      el('div', {}, el('dt', { text: t('simBaseAfter') }), el('dd', { text: fmtWon(res.after.taxableBase) })),
    ),
  );
  if (res.after.highTierWarning) box.append(el('p', { class: 'warn', text: t('highTierSim') }));
  box.append(
    el('p', { class: 'hint', text: t('simLotHint') }),
    scrollRegion(
      t('simLotRegion'),
      el(
        'table',
        { class: 'data compact' },
        el('caption', { class: 'sr-only', text: t('simLotCaption') }),
        el('thead', {}, el('tr', {},
          el('th', { scope: 'col', text: t('colAccountShort') }),
          el('th', { scope: 'col', text: t('colTicker') }),
          el('th', { scope: 'col', text: t('colBuyDate') }),
          el('th', { scope: 'col', class: 'num', text: t('colQty') }),
          el('th', { scope: 'col', class: 'num', text: t('colCostWon') }),
          el('th', { scope: 'col', class: 'num', text: t('colSellWon') }),
          el('th', { scope: 'col', class: 'num', text: t('colGainWon') }),
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
                el('td', { text: accountLabel(sale.account) }),
                el('td', { text: sale.ticker }),
                el('td', { text: fmtDate(x.buyDate) }),
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
    const res = parseNumber(e.target.value, { name: t('fieldFxNow'), decimals: LIM.fxDecimals, min: LIM.minFxKRW, max: LIM.maxFxKRW });
    setFieldError($('e-simfx'), e.target, res.ok ? '' : res.error);
    if (!res.ok) return;
    state.simFx = res.value;
    saveSettings();
    updateSimValues();
  });
  $('sim-fee').addEventListener('input', (e) => {
    const res = parseNumber(e.target.value, { name: t('fieldSimFee'), decimals: 3, min: 0, max: 10, allowEmpty: true });
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
    if (!res.lots.length) {
      window.alert(t('alertNoSuggest'));
      return;
    }
    state.sims = Object.fromEntries(res.lots.map((l) => [posKey(l.account, l.ticker), l.qty]));
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
    el('p', { class: 'kicker', text: f.status === 'open' ? t('filingOpen') : t('filingNext') }),
    el('p', { class: 'dday-num', text: f.dDay === 0 ? 'D-day' : `D-${f.dDay}` }),
    el('p', { class: 'dday-label', text: t('filingRange', { start: fmtDate(f.start), end: fmtDate(f.end), y: f.taxYear, check: CONFIRM() }) }),
    el('p', { class: 'hint', text: t('filingHint') }),
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
      el('li', { class: 'check-item' }, box, el('label', { for: id }, el('strong', { text: t(item.title) }), el('span', { class: 'hint', text: t(item.note) }))),
    );
  }
  const done = CHECKLIST.filter((c) => state.checklist[c.id]).length;
  $('filing-csv-hint').textContent = t('filingCsvHint', { y: f.taxYear, done, total: CHECKLIST.length });
}

function bindFiling() {
  $('export-filing').addEventListener('click', () => {
    const f = filingInfo(isoToday());
    const s = summarizeYear(ledger().sales, f.taxYear);
    if (!s.saleCount) {
      window.alert(t('alertNoSalesFiling', { y: f.taxYear }));
      return;
    }
    download(`gainlot-${f.taxYear}-filing.csv`, 'text/csv;charset=utf-8', salesToCsv(s.sales));
  });
}

// ---------- AI 분석 ----------

// 계좌를 합쳐 종목별 한 줄로 만듭니다. 계좌 이름은 전송하지 않습니다.
function aggregateByTicker(positions) {
  const map = new Map();
  for (const p of positions) {
    const cur = map.get(p.ticker) || { ticker: p.ticker, qty: 0, costKRW: 0, unrealizedGainKRW: null, priceUSD: p.priceUSD, lots: [] };
    cur.qty += p.qty;
    cur.costKRW += p.costKRW;
    if (p.unrealizedGainKRW !== null) cur.unrealizedGainKRW = (cur.unrealizedGainKRW ?? 0) + p.unrealizedGainKRW;
    map.set(p.ticker, cur);
  }
  return [...map.values()].sort((a, b) => (a.ticker < b.ticker ? -1 : 1));
}

function currentPayload() {
  const { sales, openLots } = ledger();
  const year = thisYear();
  const summary = summarizeYear(sales, year);
  const positions = aggregateByTicker(openPositions(openLots, state.prices, state.simFx, state.options));
  const realizedByTicker = {};
  for (const s of summary.sales) realizedByTicker[s.ticker] = (realizedByTicker[s.ticker] || 0) + s.gainKRW;
  const payload = buildPayload({ summary, positions, fxNow: state.simFx, realizedByTicker });
  return { payload, summary, positions, realizedByTicker };
}

function renderAi() {
  const { payload } = currentPayload();
  $('ai-preview').textContent = JSON.stringify(payload, null, 2);
  $('ai-key-state').textContent = state.aiKey
    ? t('aiKeySaved', { last4: state.aiKey.slice(-4) })
    : t('aiKeyNone');
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
      setFieldError($('e-aikey'), input, t('aiKeyFormat'));
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
    renderAiResult(t('aiLocalTitle'), lines, t('aiLocalNote'));
  });
  $('ai-run').addEventListener('click', async () => {
    if (!state.aiKey || state.aiBusy) return;
    const { payload, summary, positions, realizedByTicker } = currentPayload();
    state.aiBusy = true;
    $('ai-run').disabled = true;
    $('ai-result').setAttribute('aria-busy', 'true');
    renderAiResult(t('aiTitle'), [t('aiBusyText')], '');
    const res = await sendToAnthropic({ key: state.aiKey, payload });
    state.aiBusy = false;
    $('ai-result').removeAttribute('aria-busy');
    if (res.ok) {
      const lines = res.text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
      renderAiResult(t('aiTitle'), lines, t('aiGenNote'));
    } else {
      const lines = ruleBasedAnalysis({ summary, positions, fxNow: state.simFx, realizedByTicker });
      renderAiResult(t('aiFallbackTitle'), lines, '', t('aiFallbackErr', { msg: res.error }));
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
    const i = tabs.findIndex((tb) => tb.getAttribute('aria-selected') === 'true');
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

// ---------- 언어 ----------

function applyLanguage(code) {
  setLang(code);
  saveLang(code);
  applyI18n();
  document.title = t('docTitle');
  document.querySelector('meta[name="description"]').setAttribute('content', t('metaDesc'));
  $('lang-select').value = getLang();
  renderAll();
  renderOptions();
}

function bindLanguage() {
  const sel = $('lang-select');
  sel.replaceChildren(...Object.entries(LANGS).map(([k, v]) => el('option', { value: k, text: v.name })));
  sel.value = getLang();
  sel.addEventListener('change', (e) => applyLanguage(e.target.value));
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
      showReport([t('csvFileBig')], 'error');
      return;
    }
    $('csv-text').value = await file.text();
  });
  for (const btn of document.querySelectorAll('[data-load-sample]')) btn.addEventListener('click', loadSample);
  $('clear-sample').addEventListener('click', clearSample);
}

function init() {
  setLang(detectLang(readSavedLang()));
  applyI18n();
  document.title = t('docTitle');
  document.querySelector('meta[name="description"]').setAttribute('content', t('metaDesc'));
  bindLanguage();
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
