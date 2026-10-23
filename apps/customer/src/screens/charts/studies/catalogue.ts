/**
 * The study catalogue: every study the dialog offers, its category, its search words and its inputs with the defaults shown
 * in the settings fields. A default is a value shown in a field the person can change; it is never a hidden constant. A
 * field the person empties stays empty, and the study refuses until it is filled (see compute.ts).
 */
import { SOURCES } from './math';

export type StudyKind =
  | 'sma'
  | 'ema'
  | 'ichimoku'
  | 'vwap'
  | 'volume'
  | 'volume-delta'
  | 'volume-profile'
  | 'rsi'
  | 'macd'
  | 'stochastic'
  | 'bollinger'
  | 'pivots'
  | 'auto-levels'
  | 'rating'
  | 'htf-sma'
  | 'open-interest'
  | 'funding'
  | 'on-chain';

export const CATEGORIES = [
  'trend',
  'oscillators',
  'volume',
  'volatility',
  'levels',
  'analytics',
  'higher-timeframe',
  'derivatives',
  'on-chain',
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface InputDef {
  key: string;
  label: string;
  kind: 'period' | 'number' | 'source' | 'interval' | 'weight';
  /** The value shown in the field when the study is first added. */
  default: string;
}

export interface StudyDef {
  kind: StudyKind;
  /** The name in the dialog and the legend. */
  name: string;
  /** The short name used as the series label (SMA, RSI ...). */
  short: string;
  category: Category;
  /** Other words the search matches, lower case. */
  aliases: readonly string[];
  inputs: readonly InputDef[];
  /** What the study reads besides the loaded bars. */
  needs: 'bars' | 'tape' | 'higher' | 'served';
}

export const RATING_SIGNALS = [
  { id: 'sma20', label: 'SMA 20' },
  { id: 'sma50', label: 'SMA 50' },
  { id: 'sma200', label: 'SMA 200' },
  { id: 'ema20', label: 'EMA 20' },
  { id: 'ema50', label: 'EMA 50' },
  { id: 'ema200', label: 'EMA 200' },
  { id: 'rsi14', label: 'RSI 14' },
  { id: 'stoch14', label: 'Stochastic %K 14' },
  { id: 'macd', label: 'MACD 12 26 9' },
] as const;

const period = (key: string, label: string, value: string): InputDef => ({ key, label, kind: 'period', default: value });
const source: InputDef = { key: 'source', label: 'Source', kind: 'source', default: 'close' };

export const STUDIES: readonly StudyDef[] = [
  {
    kind: 'sma',
    name: 'Simple moving average',
    short: 'SMA',
    category: 'trend',
    aliases: ['sma', 'moving average', 'ma'],
    inputs: [period('period', 'Period', '20'), source],
    needs: 'bars',
  },
  {
    kind: 'ema',
    name: 'Exponential moving average',
    short: 'EMA',
    category: 'trend',
    aliases: ['ema', 'moving average'],
    inputs: [period('period', 'Period', '20'), source],
    needs: 'bars',
  },
  {
    kind: 'ichimoku',
    name: 'Ichimoku Cloud',
    short: 'Ichimoku',
    category: 'trend',
    aliases: ['ichimoku', 'cloud', 'kumo', 'tenkan', 'kijun'],
    inputs: [period('tenkan', 'Conversion (Tenkan)', '9'), period('kijun', 'Base (Kijun)', '26'), period('senkou', 'Span B', '52')],
    needs: 'bars',
  },
  {
    kind: 'vwap',
    name: 'Volume-weighted average price',
    short: 'VWAP',
    category: 'volume',
    aliases: ['vwap', 'session vwap'],
    inputs: [],
    needs: 'bars',
  },
  {
    kind: 'volume',
    name: 'Volume',
    short: 'Volume',
    category: 'volume',
    aliases: ['volume', 'vol'],
    inputs: [],
    needs: 'bars',
  },
  {
    kind: 'volume-delta',
    name: 'Volume delta',
    short: 'Delta',
    category: 'volume',
    aliases: ['delta', 'cvd', 'cumulative volume delta', 'buy sell volume', 'order flow'],
    inputs: [],
    needs: 'tape',
  },
  {
    kind: 'volume-profile',
    name: 'Volume profile',
    short: 'Profile',
    category: 'volume',
    aliases: ['profile', 'volume by price', 'poc'],
    inputs: [{ key: 'bins', label: 'Price bins', kind: 'period', default: '24' }],
    needs: 'tape',
  },
  {
    kind: 'rsi',
    name: 'Relative Strength Index',
    short: 'RSI',
    category: 'oscillators',
    aliases: ['rsi', 'relative strength', 'wilder'],
    inputs: [period('period', 'Period', '14')],
    needs: 'bars',
  },
  {
    kind: 'macd',
    name: 'Moving Average Convergence Divergence',
    short: 'MACD',
    category: 'oscillators',
    aliases: ['macd', 'convergence divergence'],
    inputs: [period('fast', 'Fast', '12'), period('slow', 'Slow', '26'), period('signal', 'Signal', '9')],
    needs: 'bars',
  },
  {
    kind: 'stochastic',
    name: 'Stochastic',
    short: 'Stoch',
    category: 'oscillators',
    aliases: ['stochastic', 'stoch', '%k', '%d'],
    inputs: [period('k', '%K period', '14'), period('d', '%D period', '3')],
    needs: 'bars',
  },
  {
    kind: 'bollinger',
    name: 'Bollinger Bands',
    short: 'BB',
    category: 'volatility',
    aliases: ['bollinger', 'bands', 'bb'],
    inputs: [period('period', 'Period', '20'), { key: 'multiplier', label: 'Deviations', kind: 'number', default: '2' }],
    needs: 'bars',
  },
  {
    kind: 'pivots',
    name: 'Pivot points',
    short: 'Pivots',
    category: 'levels',
    aliases: ['pivot', 'pivots', 'floor pivots', 'classic'],
    inputs: [],
    needs: 'bars',
  },
  {
    kind: 'auto-levels',
    name: 'Auto levels',
    short: 'Levels',
    category: 'levels',
    aliases: ['auto', 'levels', 'prior high', 'prior low', 'previous day'],
    inputs: [],
    needs: 'bars',
  },
  {
    kind: 'rating',
    name: 'Technical rating',
    short: 'Rating',
    category: 'analytics',
    aliases: ['rating', 'technical rating', 'summary', 'signals', 'counts'],
    inputs: RATING_SIGNALS.map((s) => ({ key: `w.${s.id}`, label: `Weight: ${s.label}`, kind: 'weight' as const, default: '' })),
    needs: 'bars',
  },
  {
    kind: 'htf-sma',
    name: 'Higher-timeframe moving average',
    short: 'HTF SMA',
    category: 'higher-timeframe',
    aliases: ['higher timeframe', 'htf', 'multi timeframe', 'mtf', 'daily', 'hourly'],
    inputs: [{ key: 'interval', label: 'Interval', kind: 'interval', default: '1h' }, period('period', 'Period', '20'), source],
    needs: 'higher',
  },
  {
    kind: 'open-interest',
    name: 'Open interest',
    short: 'Open interest',
    category: 'derivatives',
    aliases: ['open interest', 'oi', 'futures'],
    inputs: [],
    needs: 'served',
  },
  {
    kind: 'funding',
    name: 'Funding rate',
    short: 'Funding',
    category: 'derivatives',
    aliases: ['funding', 'funding rate', 'perpetual'],
    inputs: [],
    needs: 'served',
  },
  {
    kind: 'on-chain',
    name: 'On-chain series',
    short: 'On-chain',
    category: 'on-chain',
    aliases: ['on chain', 'onchain', 'on-chain', 'network', 'addresses'],
    inputs: [],
    needs: 'served',
  },
];

export const studyDef = (kind: StudyKind): StudyDef => STUDIES.find((s) => s.kind === kind)!;

/** The colour tokens a study can take. The desk's own chart uses the same tokens. */
export const PALETTE = ['ma-1', 'ma-2', 'ma-3', 'lime', 'up', 'down', 'fg', 'fg-2'] as const;
export type PaletteToken = (typeof PALETTE)[number];

export const SOURCE_NAMES: readonly string[] = SOURCES;

/** The dialog's search: a study matches when the search text is in its name, its short name or one of its words. */
export function searchStudies(query: string): StudyDef[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...STUDIES];
  return STUDIES.filter((s) => [s.name, s.short, ...s.aliases].some((word) => word.toLowerCase().includes(q)));
}

/** The studies grouped by category, in the order the dialog shows them. Empty groups are left out. */
export function groupByCategory(defs: readonly StudyDef[]): Array<{ category: Category; defs: StudyDef[] }> {
  return CATEGORIES.map((category) => ({ category, defs: defs.filter((d) => d.category === category) })).filter((g) => g.defs.length > 0);
}
