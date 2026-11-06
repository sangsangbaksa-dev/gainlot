import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  roundWon, computeTax, parseNumber, parseDate, validateTrade, computeLedger,
  summarizeYear, listYears, openPositions, simulateSales, suggestHeadroom,
  filingInfo, splitCsv, parseTradeCsv, salesToCsv, makeBackup, parseBackup,
} from '../logic.js';
import { TAX_CONSTANTS, DEFAULT_OPTIONS } from '../constants.js';
import { buildPrompt, buildRequest, parseReply, isPlausibleKey, ruleBasedAnalysis, buildPayload } from '../ai.js';

const DED = TAX_CONSTANTS.basicDeduction;
let seqCounter = 0;
// 테스트용 거래 생성기 (seq는 호출 순서)
function T(date, ticker, side, qty, price, fee, fx, id) {
  seqCounter += 1;
  return { id: id || `t${seqCounter}`, date, ticker, side, qty, price, fee, fx, seq: seqCounter };
}
const B = (date, ticker, qty, price, fee, fx, id) => T(date, ticker, 'BUY', qty, price, fee, fx, id);
const S = (date, ticker, qty, price, fee, fx, id) => T(date, ticker, 'SELL', qty, price, fee, fx, id);
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `expected ${a} ~ ${b}`);

describe('반올림과 세금', () => {
  test('roundWon은 0.5를 0에서 멀어지는 쪽으로 반올림한다', () => {
    assert.equal(roundWon(1000.5), 1001);
    assert.equal(roundWon(0.5), 1);
    assert.equal(roundWon(-2.5), -3);
    assert.equal(roundWon(2.4999), 2);
    assert.equal(roundWon(-0.2), 0);
  });

  test('roundWon은 유한하지 않은 값을 거부한다', () => {
    assert.throws(() => roundWon(NaN));
    assert.throws(() => roundWon(Infinity));
  });

  test('세율은 원 미만을 절사한다', () => {
    assert.equal(computeTax(1000000), 220000);
    assert.equal(computeTax(1234567), 271604); // 271604.74
    assert.equal(computeTax(0), 0);
    assert.equal(computeTax(-5), 0);
  });
});

describe('FIFO 매칭', () => {
  test('두 lot에 걸친 매도는 앞 lot부터 소진하고 원가와 차익을 계산한다', () => {
    const trades = [
      B('2024-01-02', 'AAPL', 10, 100, 0, 1000, 'b1'),
      B('2024-02-01', 'AAPL', 10, 120, 0, 1100, 'b2'),
      S('2024-03-01', 'AAPL', 15, 150, 0, 1200, 's1'),
    ];
    const { sales, openLots, errors } = computeLedger(trades);
    assert.deepEqual(errors, []);
    assert.equal(sales.length, 1);
    const s = sales[0];
    assert.equal(s.proceedsKRW, 2700000);
    assert.equal(s.costKRW, 1660000); // 10*100*1000 + 5*120*1100
    assert.equal(s.expenseKRW, 0);
    assert.equal(s.gainKRW, 1040000);
    assert.deepEqual(s.slices.map((x) => x.buyId), ['b1', 'b2']);
    assert.deepEqual(s.slices.map((x) => x.qty), [10, 5]);
    assert.equal(openLots.length, 1);
    assert.equal(openLots[0].buyId, 'b2');
    assert.equal(openLots[0].qty, 5);
  });

  test('부분 매도 후 남은 lot의 원가는 남은 수량 기준이다', () => {
    const trades = [B('2024-01-02', 'AAPL', 10, 100, 0, 1000), S('2024-02-01', 'AAPL', 3, 110, 0, 1000)];
    const { openLots } = computeLedger(trades);
    assert.equal(openLots[0].qty, 7);
    assert.equal(openLots[0].costKRW, 700000);
  });

  test('보유 수량을 초과하는 매도는 오류이고 lot을 소진하지 않는다', () => {
    const trades = [B('2024-01-02', 'AAPL', 10, 100, 0, 1000), S('2024-02-01', 'AAPL', 11, 110, 0, 1000, 'bad')];
    const { sales, openLots, errors } = computeLedger(trades);
    assert.equal(sales.length, 0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].tradeId, 'bad');
    assert.equal(openLots[0].qty, 10);
  });

  test('종목별로 lot이 분리된다 (다른 종목 보유분으로 매도할 수 없음)', () => {
    const trades = [B('2024-01-02', 'MSFT', 10, 100, 0, 1000), S('2024-02-01', 'AAPL', 1, 110, 0, 1000)];
    assert.equal(computeLedger(trades).errors.length, 1);
  });

  test('같은 날 매수와 매도: 기본은 매수 먼저 처리하여 허용한다', () => {
    const trades = [S('2024-05-01', 'AAPL', 5, 110, 0, 1000), B('2024-05-01', 'AAPL', 5, 100, 0, 1000)];
    const res = computeLedger(trades, DEFAULT_OPTIONS);
    assert.equal(res.errors.length, 0);
    assert.equal(res.sales[0].gainKRW, 50000);
  });

  test('같은 날 매수와 매도: sameDayBuyFirst=false이면 입력 순서를 따른다', () => {
    const trades = [S('2024-05-01', 'AAPL', 5, 110, 0, 1000), B('2024-05-01', 'AAPL', 5, 100, 0, 1000)];
    const res = computeLedger(trades, { ...DEFAULT_OPTIONS, sameDayBuyFirst: false });
    assert.equal(res.errors.length, 1);
  });

  test('같은 날 여러 매수는 입력(seq) 순서로 FIFO 처리된다', () => {
    const trades = [
      B('2024-05-01', 'AAPL', 2, 100, 0, 1000, 'first'),
      B('2024-05-01', 'AAPL', 2, 200, 0, 1000, 'second'),
      S('2024-06-01', 'AAPL', 3, 150, 0, 1000),
    ];
    const { sales } = computeLedger(trades);
    assert.deepEqual(sales[0].slices.map((x) => x.buyId), ['first', 'second']);
    assert.equal(sales[0].costKRW, 2 * 100000 + 1 * 200000);
  });

  test('소수점 수량도 정확히 매칭된다 (0.1 + 0.2 문제 없음)', () => {
    const trades = [B('2024-01-02', 'VOO', 0.3, 400, 0, 1000), S('2024-02-01', 'VOO', 0.1, 410, 0, 1000)];
    const { sales, openLots, errors } = computeLedger(trades);
    assert.equal(errors.length, 0);
    assert.equal(sales[0].gainKRW, 1000);
    near(openLots[0].qty, 0.2);
  });

  test('전량 매도 후에는 열린 lot이 없다', () => {
    const trades = [B('2024-01-02', 'VOO', 1.5, 100, 0, 1000), S('2024-02-01', 'VOO', 1.5, 100, 0, 1000)];
    const { openLots, errors } = computeLedger(trades);
    assert.equal(openLots.length, 0);
    assert.equal(errors.length, 0);
  });

  test('환율 차이로 생긴 차익도 원화 기준으로 계산된다', () => {
    const trades = [B('2024-01-02', 'AAPL', 10, 100, 0, 1300), S('2024-02-01', 'AAPL', 10, 100, 0, 1400)];
    assert.equal(computeLedger(trades).sales[0].gainKRW, 100000);
  });
});

describe('수수료와 필요경비', () => {
  const trades = () => [
    B('2024-01-02', 'AAPL', 10, 100, 10, 1000),
    S('2024-02-01', 'AAPL', 10, 110, 5, 1000),
  ];

  test('수수료를 필요경비로 산입하면 매수·매도 수수료가 모두 차감된다', () => {
    const s = computeLedger(trades(), { feeAsExpense: true }).sales[0];
    assert.equal(s.expenseKRW, 15000);
    assert.equal(s.gainKRW, 1100000 - 1000000 - 15000);
  });

  test('수수료를 산입하지 않으면 필요경비는 0이다', () => {
    const s = computeLedger(trades(), { feeAsExpense: false }).sales[0];
    assert.equal(s.expenseKRW, 0);
    assert.equal(s.gainKRW, 100000);
  });

  test('부분 매도 시 매수 수수료는 수량 비율로 배분된다', () => {
    const t = [B('2024-01-02', 'AAPL', 10, 100, 10, 1000), S('2024-02-01', 'AAPL', 4, 110, 0, 1000)];
    const s = computeLedger(t).sales[0];
    assert.equal(s.slices[0].buyFeeKRW, 4000);
    assert.equal(s.expenseKRW, 4000);
  });
});

describe('연간 집계: 손익 통산, 공제, 이월', () => {
  test('같은 해 이익과 손실은 통산되고 공제 안에 들면 세금은 0이다', () => {
    const sales = [
      { year: 2026, gainKRW: 3000000 },
      { year: 2026, gainKRW: -1000000 },
    ];
    const s = summarizeYear(sales, 2026);
    assert.equal(s.totalGain, 3000000);
    assert.equal(s.totalLoss, 1000000);
    assert.equal(s.net, 2000000);
    assert.equal(s.taxableBase, 0);
    assert.equal(s.tax, 0);
    assert.equal(s.headroom, 500000);
  });

  test('전년도 손실은 다음 해로 이월되지 않는다', () => {
    const sales = [
      { year: 2025, gainKRW: -1000000 },
      { year: 2026, gainKRW: 3000000 },
    ];
    const s26 = summarizeYear(sales, 2026);
    assert.equal(s26.net, 3000000);
    assert.equal(s26.taxableBase, 500000);
    assert.equal(s26.tax, 110000);
    assert.equal(s26.lossCarryForward, false);
    assert.equal(summarizeYear(sales, 2025).tax, 0);
  });

  test('공제 경계: 정확히 250만원이면 0, 1원 넘으면 과세표준 1원', () => {
    const at = (net) => summarizeYear([{ year: 2026, gainKRW: net }], 2026);
    assert.equal(at(DED).taxableBase, 0);
    assert.equal(at(DED).tax, 0);
    assert.equal(at(DED + 1).taxableBase, 1);
    assert.equal(at(DED + 1).tax, 0); // 0.22원 절사
    assert.equal(at(DED + 1000000).tax, 220000);
  });

  test('순손실이면 과세표준은 0이고 공제 여유는 공제액보다 크다', () => {
    const s = summarizeYear([{ year: 2026, gainKRW: -500000 }], 2026);
    assert.equal(s.taxableBase, 0);
    assert.equal(s.tax, 0);
    assert.equal(s.headroom, DED + 500000);
  });

  test('3억 초과 과세표준이면 경고 플래그가 켜진다 (세율은 22%로만 계산)', () => {
    const s = summarizeYear([{ year: 2026, gainKRW: 300000000 + DED + 1 }], 2026);
    assert.equal(s.highTierWarning, true);
  });

  test('listYears는 매도가 있는 연도만 오름차순으로 돌려준다', () => {
    const trades = [
      B('2024-01-02', 'AAPL', 10, 100, 0, 1000),
      S('2025-02-01', 'AAPL', 1, 110, 0, 1000),
      B('2025-03-01', 'MSFT', 1, 100, 0, 1000),
      S('2026-02-01', 'AAPL', 1, 110, 0, 1000),
    ];
    assert.deepEqual(listYears(trades), [2025, 2026]);
  });
});

describe('반올림: 매도 건 단위 마지막에 1원 반올림', () => {
  test('양도가액과 취득가액을 따로 반올림한 뒤 차익을 정수로 만든다', () => {
    const trades = [B('2024-01-02', 'X', 1, 1234.4 / 1000, 0, 1000), S('2024-02-01', 'X', 1, 2000.6 / 1000, 0, 1000)];
    const s = computeLedger(trades).sales[0];
    assert.equal(s.proceedsKRW, 2001);
    assert.equal(s.costKRW, 1234);
    assert.equal(s.gainKRW, 767);
    assert.ok(Number.isInteger(s.gainKRW));
  });

  test('0.5원 경계는 올림된다', () => {
    const trades = [B('2024-01-02', 'X', 1, 0.5, 0, 1), S('2024-02-01', 'X', 1, 1, 0, 1000.5)];
    const s = computeLedger(trades).sales[0];
    assert.equal(s.proceedsKRW, 1001);
    assert.equal(s.costKRW, 1);
    assert.equal(s.gainKRW, 1000);
  });
});

describe('입력 검증', () => {
  test('날짜: 실제 존재하지 않는 날짜와 미래 날짜를 거부한다', () => {
    assert.equal(parseDate('2026-02-30', '2026-11-06').ok, false);
    assert.equal(parseDate('2026-13-01', '2026-11-06').ok, false);
    assert.equal(parseDate('2026-11-07', '2026-11-06').ok, false);
    assert.equal(parseDate('1999-12-31', '2026-11-06').ok, false);
    assert.equal(parseDate('', '2026-11-06').ok, false);
    assert.equal(parseDate('abc', '2026-11-06').ok, false);
  });

  test('날짜: 슬래시, 점, 붙임 형식을 YYYY-MM-DD로 바꾼다', () => {
    assert.equal(parseDate('2026/03/05', '2026-11-06').value, '2026-03-05');
    assert.equal(parseDate('2026.3.5', '2026-11-06').value, '2026-03-05');
    assert.equal(parseDate('20260305', '2026-11-06').value, '2026-03-05');
  });

  test('숫자: 빈 값, NaN, Infinity, 지수 표기, 음수, 0, 소수점 초과, 너무 큰 값을 거부한다', () => {
    const q = (raw) => parseNumber(raw, { name: '수량', decimals: 6, min: 0, minExclusive: true, max: 1e9 });
    assert.equal(q('').ok, false);
    assert.equal(q('NaN').ok, false);
    assert.equal(q('Infinity').ok, false);
    assert.equal(q('1e5').ok, false);
    assert.equal(q('-1').ok, false);
    assert.equal(q('0').ok, false);
    assert.equal(q('1.1234567').ok, false);
    assert.equal(q('1000000001').ok, false);
    assert.equal(q(Number.NaN).ok, false);
    assert.equal(q({}).ok, false);
  });

  test('숫자: 천 단위 쉼표, 공백, $ 기호를 허용한다', () => {
    const p = (raw) => parseNumber(raw, { name: '단가', min: 0, minExclusive: true });
    assert.equal(p('1,234.5').value, 1234.5);
    assert.equal(p(' $ 12.5 ').value, 12.5);
  });

  test('거래 검증: 정상 입력은 대문자 티커로 정규화된다', () => {
    const r = validateTrade({ date: '2026-01-05', ticker: ' aapl ', side: '매수', qty: '1.5', price: '100', fee: '', fx: '1350' }, { today: '2026-11-06' });
    assert.equal(r.ok, true);
    assert.equal(r.trade.ticker, 'AAPL');
    assert.equal(r.trade.side, 'BUY');
    assert.equal(r.trade.qty, 1.5);
    assert.equal(r.trade.fee, 0);
  });

  test('거래 검증: 여러 필드의 오류를 모두 알려준다', () => {
    const r = validateTrade({ date: '', ticker: '<script>', side: '보유', qty: '0', price: '1e9', fee: '-1', fx: '0' }, { today: '2026-11-06' });
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors.map((e) => e.field).sort(), ['date', 'fee', 'fx', 'price', 'qty', 'side', 'ticker']);
  });

  test('거래 검증: 환율 범위와 단가 상한을 확인한다', () => {
    const base = { date: '2026-01-05', ticker: 'AAPL', side: 'BUY', qty: '1', price: '100', fee: '0', fx: '1350' };
    assert.equal(validateTrade({ ...base, fx: '99' }, { today: '2026-11-06' }).ok, false);
    assert.equal(validateTrade({ ...base, fx: '10001' }, { today: '2026-11-06' }).ok, false);
    assert.equal(validateTrade({ ...base, price: '1000001' }, { today: '2026-11-06' }).ok, false);
  });
});

describe('시뮬레이터와 공제 활용 제안', () => {
  // 2026년 초 MSFT 이익 실현 3,000,000원, AAPL 100 USD 보유 (원가 1,000,000원)
  const base = () => [
    B('2026-01-05', 'MSFT', 10, 100, 0, 1000, 'm1'),
    S('2026-02-01', 'MSFT', 10, 400, 0, 1000, 'm2'),
    B('2026-01-06', 'AAPL', 10, 100, 0, 1000, 'a1'),
  ];

  test('가상 매도 후 세금 차이를 계산한다 (손실 실현으로 공제 안으로)', () => {
    const r = simulateSales({ trades: base(), sells: [{ ticker: 'AAPL', qty: 10, priceUSD: 50 }], year: 2026, today: '2026-11-06', fxNow: 1000 });
    assert.equal(r.ok, true);
    assert.equal(r.before.net, 3000000);
    assert.equal(r.before.tax, 110000);
    assert.equal(r.after.net, 2500000);
    assert.equal(r.after.tax, 0);
    assert.equal(r.taxDelta, -110000);
    assert.equal(r.simulatedGainKRW, -500000);
  });

  test('시뮬레이션은 보유 수량을 넘으면 오류를 돌려준다', () => {
    const r = simulateSales({ trades: base(), sells: [{ ticker: 'AAPL', qty: 11, priceUSD: 50 }], year: 2026, today: '2026-11-06', fxNow: 1000 });
    assert.equal(r.ok, false);
  });

  test('시뮬레이션 매도 수수료율을 넣으면 필요경비에 반영된다', () => {
    const r = simulateSales({ trades: base(), sells: [{ ticker: 'AAPL', qty: 10, priceUSD: 200 }], year: 2026, today: '2026-11-06', fxNow: 1000, feeRate: 0.01 });
    // 매도금액 2,000,000 - 원가 1,000,000 - 수수료 20,000 = 980,000
    assert.equal(r.simulatedGainKRW, 980000);
  });

  test('공제 여유가 0이면 제안 수량도 0이다', () => {
    const r = suggestHeadroom({ trades: base(), prices: { AAPL: 150 }, fxNow: 1000, year: 2026 });
    assert.equal(r.headroomKRW, 0);
    assert.deepEqual(r.quantities, {});
  });

  test('공제 여유 안에서 FIFO 순서로 이익 lot을 실현하는 수량을 제안한다', () => {
    const trades = [
      B('2026-01-01', 'AAPL', 10, 100, 0, 1000),
      B('2026-01-02', 'AAPL', 10, 100, 0, 1000),
      B('2026-01-03', 'AAPL', 10, 100, 0, 1000),
    ];
    const r = suggestHeadroom({ trades, prices: { AAPL: 200 }, fxNow: 1000, year: 2026 });
    // 각 lot 이익 1,000,000원. 여유 2,500,000원: 두 lot 전량 + 세 번째 lot 500,000원분 = 5주
    assert.deepEqual(r.quantities, { AAPL: 25 });
    const sim = simulateSales({ trades, sells: [{ ticker: 'AAPL', qty: 25, priceUSD: 200 }], year: 2026, today: '2026-11-06', fxNow: 1000 });
    assert.equal(sim.after.net, 2500000);
    assert.equal(sim.after.tax, 0);
  });

  test('가격이 없는 종목은 제안에서 제외된다', () => {
    const trades = [B('2026-01-01', 'AAPL', 10, 100, 0, 1000)];
    const r = suggestHeadroom({ trades, prices: {}, fxNow: 1000, year: 2026 });
    assert.deepEqual(r.quantities, {});
  });

  test('openPositions: 현재가가 없으면 미실현 손익은 null이다', () => {
    const { openLots } = computeLedger(base());
    const [pos] = openPositions(openLots, {}, 1000);
    assert.equal(pos.ticker, 'AAPL');
    assert.equal(pos.unrealizedGainKRW, null);
    const [pos2] = openPositions(openLots, { AAPL: 120 }, 1300);
    assert.equal(pos2.unrealizedGainKRW, 1560000 - 1000000);
  });
});

describe('신고 기간 D-day', () => {
  test('2026-11-06 기준: 귀속 2026, 신고 기간 2027-05-01~05-31, D-206', () => {
    const f = filingInfo('2026-11-06');
    assert.equal(f.taxYear, 2026);
    assert.equal(f.start, '2027-05-01');
    assert.equal(f.end, '2027-05-31');
    assert.equal(f.status, 'upcoming');
    assert.equal(f.dDay, 206);
  });

  test('신고 기간 중이면 open이고 같은 귀속 연도를 가리킨다', () => {
    const f = filingInfo('2027-05-10');
    assert.equal(f.status, 'open');
    assert.equal(f.taxYear, 2026);
    assert.equal(f.dDay, 21);
  });

  test('6월 1일이 지나면 다음 신고 기간으로 넘어간다', () => {
    const f = filingInfo('2027-06-01');
    assert.equal(f.taxYear, 2027);
    assert.equal(f.end, '2028-05-31');
  });
});

describe('CSV 가져오기', () => {
  const TODAY = '2026-11-06';

  test('CSV 분해: 따옴표 안의 쉼표와 줄바꿈, CRLF, BOM을 처리한다', () => {
    const recs = splitCsv('﻿a,"b,c","d\ne"\r\n\r\nx,y,z\n');
    assert.equal(recs.length, 2);
    assert.deepEqual(recs[0].fields, ['a', 'b,c', 'd\ne']);
    assert.equal(recs[1].line, 4);
  });

  test('한글 헤더를 인식하고 천 단위 쉼표가 든 단가를 읽는다', () => {
    const text = '날짜,종목,구분,수량,단가,수수료,환율\n2026-01-05,aapl,매수,2.5,"1,234.5",1,1350\n';
    const r = parseTradeCsv(text, { today: TODAY });
    assert.equal(r.fatal, null);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].ok, true);
    assert.equal(r.rows[0].trade.price, 1234.5);
    assert.equal(r.rows[0].trade.ticker, 'AAPL');
  });

  test('헤더가 없으면 date,ticker,side,qty,price,fee,fx 순서로 읽는다 (탭 구분 붙여넣기도 지원)', () => {
    const text = '2026-01-05\tMSFT\tBUY\t1\t300\t\t1350\r\n2026-02-05\tMSFT\tSELL\t1\t320\t0\t1340\r\n';
    const r = parseTradeCsv(text, { today: TODAY });
    assert.equal(r.rows.length, 2);
    assert.ok(r.rows.every((x) => x.ok));
    assert.equal(r.rows[1].trade.side, 'SELL');
  });

  test('잘못된 행은 줄 번호와 사유를 남기고 나머지는 정상 처리된다', () => {
    const text = [
      'date,ticker,side,qty,price,fee,fx',
      '2026-01-05,AAPL,BUY,1,100,0,1350',
      '2026-02-30,AAPL,BUY,1,100,0,1350',
      '2026-01-06,AAPL,BUY,0,100,0,1350',
      '2026-01-07,AAPL,BUY,1,-5,0,1350',
      '2026-01-08,AAPL,HOLD,1,100,0,1350',
      '2026-01-09,AAPL,BUY,1,100,0,5',
      '2026-01-10,AAPL,BUY,1,100',
      '2026-01-11,AAPL,BUY,abc,100,0,1350',
    ].join('\n');
    const r = parseTradeCsv(text, { today: TODAY });
    assert.equal(r.rows.length, 8);
    assert.deepEqual(r.rows.map((x) => x.ok), [true, false, false, false, false, false, false, false]);
    assert.equal(r.rows[1].line, 3);
    assert.match(r.rows[1].errors[0].message, /날짜/);
    assert.match(r.rows[6].errors[0].message, /열 개수/);
    assert.match(r.rows[7].errors[0].message, /숫자/);
  });

  test('헤더에 필수 열이 빠지면 파일 전체를 거부한다', () => {
    const r = parseTradeCsv('date,ticker,qty\n2026-01-05,AAPL,1\n', { today: TODAY });
    assert.match(r.fatal, /side/);
  });

  test('빈 입력과 닫히지 않은 따옴표는 fatal이다', () => {
    assert.ok(parseTradeCsv('   \n\n', { today: TODAY }).fatal);
    assert.ok(parseTradeCsv('a,"b\n', { today: TODAY }).fatal);
  });

  test('신고용 CSV는 BOM과 헤더, 매도 건별 행을 포함한다', () => {
    const trades = [B('2026-01-05', 'AAPL', 1.5, 100, 0, 1000), S('2026-03-05', 'AAPL', 1.5, 120, 0, 1000)];
    const csv = salesToCsv(computeLedger(trades).sales);
    assert.ok(csv.startsWith('﻿매도일,종목,수량,양도가액(원),취득가액(원),필요경비(원),양도차익(원)\r\n'));
    assert.ok(csv.includes('2026-03-05,AAPL,1.5,180000,150000,0,30000'));
  });
});

describe('JSON 백업', () => {
  const TODAY = '2026-11-06';

  test('백업 후 복원하면 거래와 옵션이 그대로 돌아온다', () => {
    const trades = [{ id: 'x1', date: '2026-01-05', ticker: 'AAPL', side: 'BUY', qty: 1.5, price: 100, fee: 1, fx: 1350, seq: 1 }];
    const text = makeBackup(trades, { feeAsExpense: false, sameDayBuyFirst: true });
    const r = parseBackup(text, { today: TODAY });
    assert.equal(r.ok, true);
    assert.equal(r.trades[0].id, 'x1');
    assert.equal(r.trades[0].qty, 1.5);
    assert.equal(r.options.feeAsExpense, false);
  });

  test('잘못된 JSON, 다른 앱 파일, 잘못된 거래는 거부한다', () => {
    assert.equal(parseBackup('{not json', { today: TODAY }).ok, false);
    assert.equal(parseBackup(JSON.stringify({ app: 'other', schema: 1, trades: [] }), { today: TODAY }).ok, false);
    const bad = JSON.stringify({ app: 'gainlot', schema: 1, trades: [{ date: '2026-01-05', ticker: 'AAPL', side: 'BUY', qty: -1, price: 1, fee: 0, fx: 1350 }] });
    const r = parseBackup(bad, { today: TODAY });
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /1번째 거래/);
  });

  test('보유 수량을 넘는 매도가 들어 있는 백업은 거부한다', () => {
    const bad = JSON.stringify({
      app: 'gainlot', schema: 1,
      trades: [{ date: '2026-01-05', ticker: 'AAPL', side: 'SELL', qty: 1, price: 1, fee: 0, fx: 1350 }],
    });
    assert.equal(parseBackup(bad, { today: TODAY }).ok, false);
  });
});

describe('AI 패널 로직 (네트워크 없이 검증)', () => {
  const summary = {
    year: 2026, totalGain: 3000000, totalLoss: 0, net: 3000000, deduction: DED,
    taxableBase: 500000, tax: 110000, headroom: 0,
    sales: [{ year: 2026, date: '2026-02-01', id: 'secret-id', gainKRW: 3000000 }],
  };
  const positions = [
    { ticker: 'AAPL', qty: 10, costKRW: 1000000, unrealizedGainKRW: 500000, priceUSD: 150, lots: [{ buyId: 'secret', date: '2026-01-06' }] },
  ];

  test('전송 데이터는 종목별 합계와 원화 금액만 담고 날짜·ID·계좌 정보는 없다', () => {
    const payload = buildPayload({ summary, positions, fxNow: 1350, realizedByTicker: { AAPL: 0 } });
    const text = JSON.stringify(payload);
    assert.ok(!text.includes('2026-01-06'));
    assert.ok(!text.includes('secret'));
    assert.ok(!text.includes('lots'));
    assert.equal(payload.positions[0].ticker, 'AAPL');
    assert.equal(payload.summary.tax, 110000);
  });

  test('요청 본문은 모델, max_tokens 700 이하, 필수 헤더를 가진다', () => {
    const payload = buildPayload({ summary, positions, fxNow: 1350, realizedByTicker: {} });
    const req = buildRequest('sk-ant-api03-' + 'a'.repeat(40), payload);
    assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(req.headers['x-api-key'].startsWith('sk-ant-'), true);
    assert.equal(req.headers['anthropic-version'], '2023-06-01');
    assert.equal(req.headers['anthropic-dangerous-direct-browser-access'], 'true');
    const body = JSON.parse(req.body);
    assert.equal(body.model, 'claude-haiku-5-5');
    assert.ok(body.max_tokens <= 700);
    assert.equal(body.messages[0].role, 'user');
    assert.ok(buildPrompt(payload).system.length > 0);
  });

  test('키 형식 확인: sk-ant- 접두사와 공백 없는 문자열만 통과한다', () => {
    assert.equal(isPlausibleKey('sk-ant-api03-' + 'a'.repeat(40)), true);
    assert.equal(isPlausibleKey('  sk-ant-api03-' + 'a'.repeat(40) + '  '), true);
    assert.equal(isPlausibleKey('sk-ant-short'), false);
    assert.equal(isPlausibleKey('sk-proj-' + 'a'.repeat(40)), false);
    assert.equal(isPlausibleKey('sk-ant-' + 'a'.repeat(40) + ' x'), false);
    assert.equal(isPlausibleKey(''), false);
    assert.equal(isPlausibleKey(null), false);
  });

  test('응답 파싱: text 블록만 꺼내 제어문자를 지우고 길이를 제한한다', () => {
    const ok = parseReply({ content: [{ type: 'text', text: '안녕\u0007하세요' }, { type: 'tool_use' }] });
    assert.equal(ok.ok, true);
    assert.equal(ok.text, '안녕하세요');
    const long = parseReply({ content: [{ type: 'text', text: 'a'.repeat(5000) }] });
    assert.ok(long.text.length <= 3000);
  });

  test('응답 파싱: 형식이 틀리면 실패로 돌려준다', () => {
    assert.equal(parseReply(null).ok, false);
    assert.equal(parseReply({}).ok, false);
    assert.equal(parseReply({ content: 'x' }).ok, false);
    assert.equal(parseReply({ content: [{ type: 'text', text: '   ' }] }).ok, false);
    assert.equal(parseReply({ error: { message: 'bad' } }).ok, false);
  });

  test('규칙 기반 분석은 과세표준이 있으면 손실 종목 정리를, 없으면 공제 여유 활용을 안내한다', () => {
    const withTax = ruleBasedAnalysis({ summary, positions, fxNow: 1350, realizedByTicker: {} });
    assert.ok(withTax.some((l) => l.includes('손실')));
    const noTax = ruleBasedAnalysis({
      summary: { ...summary, taxableBase: 0, tax: 0, headroom: 1000000, net: 1500000 },
      positions, fxNow: 1350, realizedByTicker: {},
    });
    assert.ok(noTax.some((l) => l.includes('공제 여유')));
    assert.ok(noTax.every((l) => typeof l === 'string' && l.length < 300));
  });
});
