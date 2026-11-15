import { defineCopy } from '../../shared/i18n';

// A strategy's risk screen (AL-risk-01; J-algo-dev-05 #7, #8).
const en = {
  title: 'Risk caps and trading',
  intro:
    'Your own limits for this strategy. Each cap starts blank and is never filled in for you. Trading stays off until every cap is set, and turns off again whenever you save a new version.',
  depositPercent: 'Deposit-percentage cap',
  depositPercentHint: 'The share of your deposit this strategy may use, in percent (above 0, at most 100).',
  maxPositionNotional: 'Position notional cap',
  maxPositionNotionalHint: 'The largest a position may grow, in the strategy’s quote currency.',
  maxDailyLoss: 'Daily loss cap',
  maxDailyLossHint: 'The most the strategy may lose in one UTC day, in the strategy’s quote currency.',
  equityFloor: 'Equity-stop floor',
  equityFloorHint:
    'Below this equity the strategy turns reduce-only: it may close, never open. Backtests of this strategy apply it at each bar’s low.',
  floorPolicy: 'When the floor is hit',
  reduce_only: 'Reduce-only: no new entries',
  close_out: 'Reduce-only, and close the position once',
  save: 'Save caps',
  saving: 'Saving',
  saved: 'Caps saved.',
  blankList: 'Still blank: {caps}.',
  noneBlank: 'Every cap is set.',
  trading: 'Trading',
  tradingOn: 'Trading is on for version {version}.',
  tradingOff: 'Trading is off.',
  offByNewVersion:
    'Trading turned off when version {latest} was saved; it was on for version {version}. Turn it on again for this version.',
  refused: 'Trading stays off. Set every cap first; still blank: {caps}.',
  invalid: 'Not saved: {detail}.',
  simulated: 'Every run of this strategy is simulated; nothing here moves money.',
} as const;

export const riskCopy = defineCopy('quant.risk', en);
