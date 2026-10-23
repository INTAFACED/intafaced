import { defineCopy } from '../../shared/i18n';

// The no-code builder in Studio (J-algo-dev-01 #3). Input names and numbers enter through parameters.
const en = {
  rulesKind: 'How the strategy trades',
  kindBlocks: 'Order blocks',
  kindSignal: 'Signal rules (no-code builder)',
  title: 'Signal rules',
  intro: 'Buy when the fast average crosses above the slow one, sell when it crosses back below. Every number is yours to set.',
  symbol: 'Symbol',
  barSize: 'Bar size',
  average: 'Average',
  sma: 'Simple moving average',
  ema: 'Exponential moving average',
  fast: 'Fast average (bars)',
  slow: 'Slow average (bars)',
  sizingKind: 'Size each entry by',
  quantity: 'Quantity',
  cash: 'Cash amount',
  percent_equity: 'Percent of simulated equity',
  sizingValue: 'Size',
  stopLoss: 'Stop loss (percent, optional)',
  takeProfit: 'Take profit (percent, optional)',
  build: 'Build source',
  building: 'Building the source',
  sourceTitle: 'Generated source',
  sourceNote: 'Read only. Studio writes this from the rules above; change the rules to change it.',
  staleSource: 'The rules changed since this source was built. Build again to see the source for the current rules.',
  unset: 'Fill in {input} first. Nothing ran.',
  outOfRange: '{input} is outside its range: {detail}. Nothing ran.',
  invalid: '{input} is not valid: it {detail}. Nothing ran.',
  sizingUnset: 'Fill in {input} first: Studio never picks a size for you. Nothing ran.',
} as const;

export const builderCopy = defineCopy('quant.builder', en);
