// 화면 제어. 계산은 logic.js와 ai.js에 있고, 여기서는 입력을 읽고 결과를 그립니다.
// 사용자 데이터는 textContent로만 넣습니다 (innerHTML 사용 안 함).
import { TAX_CONSTANTS, DEFAULT_OPTIONS, FX_BASIS_NOTE } from './constants.js';
import {
  newId, isoToday, parseNumber, validateTrade, computeLedger, summarizeYear, summarizeByAccount,
  compareYears, accountsOf, listYears, openPositions, simulateSales, suggestHeadroom, filingInfo,
  parseTradeCsv, salesToCsv, makeBackup, parseBackup, sampleTrades, DEFAULT_ACCOUNT,
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
const CONFIRM = '확인 필요';
const CHECKLIST = [
  { id: 'stmt', title: '해외 증권사 연간 매매명세(거래내역서)', note: '체결일, 종목, 수량, 단가(USD), 수수료가 모두 나오는지 확인하세요.' },
  { id: 'fx', title: '환율 근거 자료', note: '거래일 또는 결제일 기준환율 중 무엇을 썼는지 출처와 함께 남기세요. 기준 선택은 세무 판단입니다.' },
  { id: 'fee', title: '외화 수수료 기록', note: '매수·매도 수수료(USD)와 원화 환산 내역. 필요경비 산입 여부를 확인하세요.' },
  { id: 'transfer', title: '원화 송금 · 외화 환전 내역', note: '취득 자금의 출처와 환전 환율을 증명할 수 있는 입출금 기록.' },
  { id: 'other', title: '배당·이자 등 다른 해외 소득 확인', note: '양도소득과 별도로 신고할 소득이 있는지 확인하세요.' },
  { id: 'loss', title: '손실 이월 여부 확인', note: '양도 결손금은 다음 해로 넘어가지 않는 것으로 설정했습니다 (확인 필요). 같은 해 손익만 통산합니다.' },
  { id: 'account', title: '해외금융계좌 신고 대상 여부', note: '보유 계좌 잔액 기준의 별도 신고 의무가 있는지 확인하세요.' },
  { id: 'csv', title: '신고용 CSV 내려받기 및 대조', note: '계산기의 매도 건별 금액과 증권사 자료가 일치하는지 대조하세요.' },
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
const thisYear = () => Number(isoToday().slice(0, 4));
const fmtWon = (n) => `${(Math.round(n) || 0).toLocaleString('ko-KR')}원`;
const fmtSigned = (n) => {
  const v = Math.round(n) || 0;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('ko-KR')}원`;
};
const fmtQty = (n) => n.toLocaleString('ko-KR', { maximumFractionDigits: 6 });
const fmtUsd = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 4 });
const fmtRate = (n) => n.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
const posKey = (account, ticker) => JSON.stringify([account, ticker]);
const accountOf = (t) => t.account || DEFAULT_ACCOUNT;

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

function tradeKey(t) {
  return [accountOf(t), t.date, t.ticker, t.side, t.qty, t.price, t.fee, t.fx].join('|');
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
    if (typeof settings.lastAccount === 'string') state.lastAccount = settings.lastAccount.slice(0, 20);
    if (settings.yearView === 'split') state.yearView = 'split';
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

function renderRulesBadge() {
  const { appliesTo, asOf, basicDeduction, totalRate } = TAX_CONSTANTS;
  $('rules-badge').textContent =
    `적용 기준: ${appliesTo} · ${asOf} · 기본공제 ${basicDeduction.toLocaleString('ko-KR')}원 (${CONFIRM}) · 세율 ${Math.round(totalRate * 100)}% (${CONFIRM})`;
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
    box.append(
      el('strong', { text: '계산을 확정할 수 없는 거래가 있습니다.' }),
      el('p', { class: 'hint', text: '아래 내용을 고치기 전까지 연간 요약과 시뮬레이터 결과는 정확하지 않을 수 있습니다. 해당 계좌의 매수 기록과 체결일을 확인하세요.' }),
    );
    for (const e of errors.slice(0, 5)) box.append(el('p', { text: e.message }));
    if (errors.length > 5) box.append(el('p', { text: `그 밖에 ${errors.length - 5}건이 더 있습니다.` }));
  }
}

function renderSampleBanner() {
  const has = state.trades.some((t) => t.sample);
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
  f.account.value = accountOf(t);
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
  state.lastAccount = res.trade.account === DEFAULT_ACCOUNT ? '' : res.trade.account;
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
  if (!window.confirm(`${t.date} ${t.ticker} ${t.side === 'BUY' ? '매수' : '매도'} 거래(${accountOf(t)})를 삭제할까요?`)) return;
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
        el('td', {}, el('span', { text: accountOf(t) }), t.sample ? el('span', { class: 'tag sample', text: '예시' }) : null),
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
          el('button', { type: 'button', class: 'btn btn-ghost btn-xs', 'aria-label': `${t.date} ${t.ticker} ${accountOf(t)} 거래 수정`, text: '수정', onclick: () => startEdit(t.id) }),
          el('button', { type: 'button', class: 'btn btn-danger-ghost btn-xs', 'aria-label': `${t.date} ${t.ticker} ${accountOf(t)} 거래 삭제`, text: '삭제', onclick: () => removeTrade(t.id) }),
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
    window.alert('거래가 이미 있으면 예시 데이터를 넣지 않습니다. 예시는 빈 화면에서만 불러올 수 있습니다.');
    return;
  }
  const added = sampleTrades().map((t, i) => ({ id: newId(), ...t, seq: i + 1, sample: true }));
  const out = commitTrades(added);
  if (!out.ok) {
    window.alert(`예시 데이터를 불러오지 못했습니다. ${out.message}`);
    return;
  }
  state.year = null;
  renderAll();
}

function clearSample() {
  const n = state.trades.filter((t) => t.sample).length;
  if (!n) return;
  if (!window.confirm(`예시 거래 ${n}건만 지웁니다. 직접 입력한 거래는 남습니다. 계속할까요?`)) return;
  const out = commitTrades(state.trades.filter((t) => !t.sample));
  if (!out.ok) window.alert(`예시를 지우면 계산이 깨집니다.\n${out.message}`);
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
    showReport(['가져오기를 취소했습니다. 다음 매도가 계좌의 보유 수량을 넘습니다.', ...check.errors.slice(0, 5).map((e) => e.message)], 'error');
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
    `${added.length}건을 가져왔습니다. 이미 있던 거래 ${dup}건은 건너뛰었습니다.`,
    `인식한 열: ${Object.entries(res.mapping || {}).map(([f, h]) => `${h}→${f}`).join(', ')}`,
  ];
  let extra = null;
  if (skipped.length) {
    lines.push(`오류 ${skipped.length}행은 가져오지 않았습니다. 줄 번호와 사유는 아래와 같습니다.`);
    extra = el(
      'div',
      { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': '가져오기 오류 행 목록' },
      el(
        'table',
        { class: 'data compact' },
        el('caption', { class: 'sr-only', text: '오류가 있어 가져오지 않은 행' }),
        el('thead', {}, el('tr', {}, el('th', { scope: 'col', text: '줄' }), el('th', { scope: 'col', text: '사유' }))),
        el('tbody', {}, skipped.slice(0, 50).map((s) => el('tr', {}, el('td', { class: 'num', text: `${s.line}행` }), el('td', { text: s.text })))),
      ),
    );
    if (skipped.length > 50) lines.push(`오류 행이 ${skipped.length - 50}개 더 있습니다. 파일을 고쳐 다시 가져오세요.`);
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
  $('year-view').value = state.yearView;
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
    card('양도차익 합계', fmtWon(s.totalGain), `매도 ${s.saleCount}건 중 이익 건 합계 (계좌 합산)`),
    card('양도차손 합계', fmtWon(s.totalLoss), '같은 해 이익과 통산합니다'),
    card('순손익', fmtSigned(s.net), '다른 해 손실은 이월되지 않음 · 확인 필요'),
    card('기본공제', fmtWon(s.deduction), `연 1회, 계좌와 관계없이 한 번 · ${CONFIRM}`),
    card('과세표준', fmtWon(s.taxableBase), '순손익에서 기본공제를 뺀 금액'),
    card(`예상 세액 (${Math.round(s.rate * 100)}%)`, fmtWon(s.tax), `원 미만 절사 · 세율 ${CONFIRM}`, 'stat-key'),
    card('공제 여유', fmtWon(s.headroom), '이 금액까지 이익을 실현해도 세금 0원 (기준 확인 필요)'),
  );
  const notes = $('year-notes');
  notes.textContent = s.highTierWarning
    ? '과세표준이 3억 원을 넘습니다. 이 계산기는 3억 초과 구간의 추가 세율을 적용하지 않으므로 세무사와 반드시 확인하세요.'
    : `${state.year}년 손익만 계산합니다. 세액은 모든 계좌를 합산해 한 번만 계산합니다. 손실은 다음 해로 넘어가지 않습니다 (${CONFIRM}).`;

  renderCompare(sales);
  renderAccountSplit(sales);

  $('sale-count').textContent = s.saleCount ? `${s.saleCount}건` : '';
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
        el('th', { scope: 'row' }, el('button', { type: 'button', class: 'btn btn-ghost btn-xs year-pick', 'aria-pressed': String(current), text: `${r.year}년`, onclick: () => { state.year = r.year; renderYear(); } })),
        el('td', { class: 'num', text: `${r.saleCount}건` }),
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
        el('th', { scope: 'row', text: r.account }),
        el('td', { class: 'num', text: `${r.saleCount}건` }),
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
      el('span', { class: 'sale-title', text: `${sale.date} · ${sale.ticker} · ${fmtQty(sale.qty)}주 · ${sale.account || DEFAULT_ACCOUNT}` }),
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
    el('p', { class: 'hint', text: '사용한 매수 lot (선입선출, 같은 계좌 안에서만). 각 칸은 1원 단위로 표시하며, 합계는 매도 건 단위로 다시 반올림합니다.' }),
    scrollRegion(
      `${sale.ticker} 매도에 쓴 매수 lot`,
      el(
        'table',
        { class: 'data compact' },
        el('caption', { class: 'sr-only', text: `${sale.date} ${sale.ticker} 매도에 쓴 매수 lot` }),
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
      el('h1', { text: `${state.year}년 귀속 해외주식 양도소득 요약` }),
      el('p', { text: `gainlot 계산 결과 · 출력일 ${isoToday()} · 신고 기간 ${f.start} ~ ${f.end} (${CONFIRM})` }),
      el('p', { class: 'print-warn', text: '이 문서는 참고용 추정치이며 세무·법률·투자 자문이 아닙니다. 실제 신고 전 세무사 또는 국세청 자료로 확인하세요.' }),
    ),
    el('section', {},
      el('h2', { text: '적용 상수' }),
      el('ul', {},
        el('li', { text: `기본공제: ${TAX_CONSTANTS.basicDeduction.toLocaleString('ko-KR')}원 (${CONFIRM})` }),
        el('li', { text: `세율: ${Math.round(TAX_CONSTANTS.totalRate * 100)}%, 지방소득세 포함 단순 합산 (${CONFIRM})` }),
        el('li', { text: `손실 이월: 없음 (${CONFIRM})` }),
        el('li', { text: `환율: 거래마다 입력한 값을 사용 (기준 선택은 세무 판단)` }),
        el('li', { text: `수수료: ${state.options.feeAsExpense ? '필요경비 산입' : '필요경비 비산입'} (${CONFIRM})` }),
        el('li', { text: `기준: ${TAX_CONSTANTS.appliesTo} · ${TAX_CONSTANTS.asOf}` }),
      ),
    ),
    el('section', {},
      el('h2', { text: '연간 요약 (계좌 합산)' }),
      table('합산 기준 계산', [{ label: '항목' }, { label: '금액', num: true }], [
        el('tr', {}, cell('양도차익 합계'), cell(fmtWon(s.totalGain), true)),
        el('tr', {}, cell('양도차손 합계'), cell(fmtWon(s.totalLoss), true)),
        el('tr', {}, cell('순손익'), cell(fmtSigned(s.net), true)),
        el('tr', {}, cell('기본공제'), cell(fmtWon(s.deduction), true)),
        el('tr', {}, cell('과세표준'), cell(fmtWon(s.taxableBase), true)),
        el('tr', {}, cell(`예상 세액 (${Math.round(s.rate * 100)}%)`), cell(fmtWon(s.tax), true)),
        el('tr', {}, cell('공제 여유'), cell(fmtWon(s.headroom), true)),
      ]),
    ),
    el('section', {},
      el('h2', { text: '계좌별 손익' }),
      table('계좌별 손익 (세액은 합산으로만 계산)', [{ label: '계좌' }, { label: '매도 건수', num: true }, { label: '이익 합계', num: true }, { label: '차손 합계', num: true }, { label: '순손익', num: true }],
        summarizeByAccount(sales, state.year).map((r) => el('tr', {}, cell(r.account), cell(`${r.saleCount}건`, true), cell(fmtWon(r.totalGain), true), cell(fmtWon(r.totalLoss), true), cell(fmtSigned(r.net), true)))),
    ),
    el('section', {},
      el('h2', { text: '연도별 비교' }),
      table('연도별 비교', [{ label: '귀속' }, { label: '순손익', num: true }, { label: '과세표준', num: true }, { label: '예상 세액', num: true }, { label: '공제 여유', num: true }],
        compareYears(sales, years, TAX_CONSTANTS).map((r) => el('tr', {}, cell(`${r.year}년`), cell(fmtSigned(r.net), true), cell(fmtWon(r.taxableBase), true), cell(fmtWon(r.tax), true), cell(fmtWon(r.headroom), true)))),
    ),
    el('section', {},
      el('h2', { text: `매도 건별 내역 (${state.year}년)` }),
      s.sales.length
        ? table('매도 건별 내역', [{ label: '매도일' }, { label: '계좌' }, { label: '종목' }, { label: '수량', num: true }, { label: '양도가액', num: true }, { label: '취득가액', num: true }, { label: '필요경비', num: true }, { label: '양도차익', num: true }],
          s.sales.map((x) => el('tr', {}, cell(x.date), cell(accountOf(x)), cell(x.ticker), cell(fmtQty(x.qty), true), cell(fmtWon(x.proceedsKRW), true), cell(fmtWon(x.costKRW), true), cell(fmtWon(x.expenseKRW), true), cell(fmtSigned(x.gainKRW), true))))
        : el('p', { text: '이 연도의 매도 거래가 없습니다.' }),
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
      window.alert(`${state.year}년 매도 거래가 없어 내려받을 내용이 없습니다.`);
      return;
    }
    download(`gainlot-${state.year}-매도내역.csv`, 'text/csv;charset=utf-8', salesToCsv(s.sales));
  });
  $('print-year').addEventListener('click', printYearReport);
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
    const t = pos.ticker;
    const key = posKey(pos.account, t);
    const sellErr = el('span', { class: 'field-error', id: `sim-serr-${simId(key)}` });
    const sellInput = el('input', {
      type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0',
      'aria-label': `${pos.account} ${t} 매도 수량`, value: state.sims[key] !== undefined ? String(state.sims[key]) : '',
    });
    const unreal = el('td', { class: 'num' });
    sellInput.addEventListener('input', () => onSimQty(key, pos.qty, sellInput, sellErr));
    simRowRefs.set(key, { unreal, ticker: t });
    body.append(
      el(
        'tr',
        {},
        el('th', { scope: 'row', text: pos.account }),
        el('td', { text: t }),
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
  for (const t of tickers) {
    const id = `sim-price-${simId(t)}`;
    const err = el('span', { class: 'field-error', id: `sim-perr-${simId(t)}` });
    const input = el('input', {
      type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '현재가 (USD)', id,
      'aria-label': `${t} 현재가 (USD)`, value: state.prices[t] !== undefined ? String(state.prices[t]) : '',
    });
    input.addEventListener('input', () => onSimPrice(t, input, err));
    box.append(el('div', { class: 'price-field' }, el('label', { for: id, text: t }), input, err));
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

function onSimQty(key, held, input, errNode) {
  const raw = input.value.trim();
  if (raw === '') {
    delete state.sims[key];
    setFieldError(errNode, input, '');
  } else {
    const res = parseNumber(raw, { name: '매도 수량', decimals: LIM.qtyDecimals, min: 0, max: held });
    if (!res.ok) {
      setFieldError(errNode, input, res.error.replace(/이하로 입력하세요$/, `이하로 입력하세요 (이 계좌 보유 ${fmtQty(held)}주)`));
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
    el('p', {}, '올해 실현 순손익(계좌 합산) ', el('strong', { text: fmtSigned(s.net) }), ' · 공제 여유 ', el('strong', { text: fmtWon(s.headroom) })),
    el('p', { class: 'hint', text: `현재 예상 세액 ${fmtWon(s.tax)}. 공제 여유는 이 금액까지 이익을 실현해도 세금이 0원이라는 뜻입니다 (기본공제 ${CONFIRM}).` }),
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
    box.append(el('h3', { text: '시뮬레이션 결과' }), el('p', { class: 'hint', text: '매도 수량을 입력하면 같은 선입선출 규칙으로 세금 변화를 계산합니다.' }));
    return;
  }
  const missing = [...new Set(sells.filter((s) => !(s.priceUSD > 0)).map((s) => s.ticker))];
  if (missing.length) {
    box.append(el('h3', { text: '시뮬레이션 결과' }), el('p', { class: 'warn', text: `현재가를 입력하세요: ${missing.join(', ')}` }));
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
    el('p', { class: 'hint', text: '이번 매도로 사용되는 lot (선입선출, 계좌별). 매도가와 취득가는 1원 단위 참고값이며, 세금은 연간 합계로 계산합니다.' }),
    scrollRegion(
      '시뮬레이션에 쓰인 매수 lot',
      el(
        'table',
        { class: 'data compact' },
        el('caption', { class: 'sr-only', text: '가상 매도에 쓰이는 매수 lot' }),
        el('thead', {}, el('tr', {},
          el('th', { scope: 'col', text: '계좌' }),
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
                el('td', { text: sale.account }),
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
    if (!res.lots.length) {
      window.alert('제안할 이익 실현 수량이 없습니다. 현재가를 입력했는지, 공제 여유가 있는지 확인하세요.');
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
    el('p', { class: 'kicker', text: f.status === 'open' ? '신고 기간 중' : '다음 신고 기간' }),
    el('p', { class: 'dday-num', text: f.dDay === 0 ? 'D-day' : `D-${f.dDay}` }),
    el('p', { class: 'dday-label', text: `${f.start} ~ ${f.end} · 귀속 ${f.taxYear}년 · ${CONFIRM}` }),
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
    `귀속 ${f.taxYear}년 매도 건을 내려받습니다 (계좌 열은 없음, 기존 신고용 형식 유지). 준비 ${done}/${CHECKLIST.length}개 완료.`;
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
      setFieldError($('e-aikey'), input, 'sk-ant- 로 시작하는 키 형식이 아닙니다. 키 앞뒤 공백과 줄바꿈을 지우고 다시 확인하세요.');
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
      showReport(['파일이 너무 큽니다 (2MB 제한). 연도별로 나눠 가져오세요.'], 'error');
      return;
    }
    $('csv-text').value = await file.text();
  });
  for (const btn of document.querySelectorAll('[data-load-sample]')) btn.addEventListener('click', loadSample);
  $('clear-sample').addEventListener('click', clearSample);
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
