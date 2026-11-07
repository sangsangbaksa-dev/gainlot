// 세법 상수와 계산 옵션을 한곳에 모았습니다.
// 세법이나 수수료 규정이 바뀌면 이 파일의 값만 고치면 됩니다.
// 아래 값은 작성 시점의 공개 자료를 기억에 근거해 넣은 것이며, 공식 자료로 다시 확인하지 않았습니다.
// 반드시 README의 "계산 규칙" 표와 함께 확인하세요.

export const TAX_CONSTANTS = Object.freeze({
  // 적용 연도 / 기준일 (화면 상단과 결과 카드에 그대로 표시됩니다)
  appliesTo: '2026년 귀속 (2027년 5월 신고) 기준',
  asOf: '2026-11-06 작성 · 공식 자료 재확인 필요',
  // 아래 세법 상수는 모두 '확인 필요' 상태입니다 (화면과 인쇄 리포트에 같은 표기를 씁니다).
  status: '확인 필요',

  taxYear: 2026,

  // 국외주식 양도소득 기본공제 (소득세법 제103조, 연 250만원)
  basicDeduction: 2500000,

  // 세율: 국외 상장주식 양도소득 20% + 지방소득세 2% = 22% (단순 합산 방식으로 입력)
  // 주의: 지방소득세를 국세의 10%로 계산하는 방식이면 결과가 같습니다. 3억 초과 구간은 아래 highTier 참고.
  totalRate: 0.22,

  // 3억 원 초과 과세표준에 25%가 붙는다는 기억이 있으나 이 앱은 적용하지 않고 경고만 표시합니다. (UNCERTAIN)
  highTierThreshold: 300000000,

  // 신고 기간: 귀속 연도 다음 해 5월 1일 ~ 5월 31일
  filingWindow: Object.freeze({ startMD: '05-01', endMD: '05-31' }),

  // 양도소득 결손금 이월: 허용하지 않음 (해당 연도 안에서만 손익 통산)
  lossCarryForward: false,

  // 입력 검증 한계
  limits: Object.freeze({
    minDate: '2000-01-01',
    maxQty: 1000000000,
    qtyDecimals: 6,
    maxPriceUSD: 1000000,
    priceDecimals: 4,
    maxFeeUSD: 100000,
    feeDecimals: 4,
    minFxKRW: 100,
    maxFxKRW: 10000,
    fxDecimals: 2,
  }),

  // 거래 입력 폼의 환율 기본값 (예시일 뿐이므로 거래일 환율로 반드시 수정)
  defaultFxKRW: 1350,
});

// 계산 옵션 (화면에서 바꿀 수 있고, 백업 파일에 함께 저장됩니다)
export const DEFAULT_OPTIONS = Object.freeze({
  // 수수료를 필요경비(취득가액 부대비용, 양도비용)로 산입할지 여부. (UNCERTAIN, 기본 산입)
  feeAsExpense: true,
  // 같은 날 매수와 매도가 함께 있으면 매수를 먼저 처리할지 여부. (체결 순서를 알 수 없으므로 기본 매수 우선)
  sameDayBuyFirst: true,
});

// 환율 기준 안내 문구 (계산에는 쓰이지 않고, 사용자가 거래마다 입력한 환율을 그대로 씁니다)
export const FX_BASIS_NOTE =
  '환율은 거래마다 직접 입력합니다. 거래일 기준환율과 결제일 기준환율 중 무엇을 쓸지는 세무 판단이 필요합니다. 이 앱은 입력한 환율을 그대로 사용합니다.';
