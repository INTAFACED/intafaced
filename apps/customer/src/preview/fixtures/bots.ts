import { definePreviewFixture } from './types';

/**
 * SAMPLE data for the trading-bots Preview (grid, DCA and TWAP). Invented numbers, never mixed with real data. See ../README.md.
 * Money is a decimal string; a ratio is a decimal string ("0.0125" is 1.25%). Nothing here is read from the account.
 */
export type SampleBotKind = 'grid' | 'dca' | 'twap';
export type SampleBotPair = 'BTC-USDT' | 'ETH-USDT' | 'SOL-USDT';
export type SampleBotState = 'running' | 'stopped' | 'finished';
export type SampleBotFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface SampleBotMarket {
  readonly pair: SampleBotPair;
  readonly base: string;
  readonly price: string;
  /** Smallest price step, as a decimal string (used for the steppers). */
  readonly tick: string;
}

export interface SampleBot {
  readonly id: string;
  readonly kind: SampleBotKind;
  readonly pair: SampleBotPair;
  readonly state: SampleBotState;
  /** One plain line of settings, for example "Range $60,000.00 to $68,000.00, 24 grids". */
  readonly settings: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly invested: string;
  /** Sample profit or loss in USD. Null for a TWAP, which has no profit: it reports progress instead. */
  readonly profit: string | null;
  /** Whole-number count of filled orders or buys. */
  readonly fills: number;
  /** TWAP only: share of the total size done, 0 to 100. */
  readonly progressPercent?: number;
  /** A small curve of the bot's sample value over time, oldest first. */
  readonly curve: readonly string[];
}

export interface SampleBotsRows {
  /** The sample clock: running times are measured to this moment, never to the real time. */
  readonly asOf: string;
  readonly markets: readonly SampleBotMarket[];
  readonly bots: readonly SampleBot[];
  /** Sample profit across all bots, in USD, oldest first. The last point equals the sum of every bot's profit. */
  readonly performance: { readonly d7: readonly string[]; readonly d30: readonly string[] };
  readonly defaults: {
    readonly grid: { pair: SampleBotPair; low: string; high: string; grids: string; invest: string };
    readonly dca: { pair: SampleBotPair; perBuy: string; frequency: SampleBotFrequency; buys: string; takeProfit: string };
    readonly twap: { side: 'buy' | 'sell'; pair: SampleBotPair; total: string; hours: string; intervalMinutes: string; slippage: string };
  };
  /** Sample balance the create form draws on. Labelled "sample" on screen. */
  readonly sampleBalance: string;
}

/** Whole cents to a decimal string: 15305 -> "153.05", -620 -> "-6.20". Integer arithmetic only. */
function cents(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * A wobbling line in whole cents from `startCents` to exactly `endCents`. Integer arithmetic and a fixed seed, so it is the same
 * every time. The first and last points sit on the ends.
 */
function curve(seed: number, points: number, startCents: number, endCents: number, wobble: number): readonly string[] {
  let state = seed;
  const values: string[] = [];
  for (let i = 0; i < points; i++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const noise = i === 0 || i === points - 1 ? 0 : (state % (2 * wobble + 1)) - wobble;
    const base = startCents + Math.trunc(((endCents - startCents) * i) / (points - 1));
    values.push(cents(base + noise));
  }
  return values;
}

const bots: readonly SampleBot[] = [
  {
    id: 'grid-btc',
    kind: 'grid',
    pair: 'BTC-USDT',
    state: 'running',
    settings: 'Range $60,000.00 to $68,000.00, 24 grids',
    startedAt: '2026-10-02T09:30:00Z',
    invested: '2000.00',
    profit: '86.40',
    fills: 143,
    curve: curve(11, 24, 0, 8640, 420),
  },
  {
    id: 'grid-eth',
    kind: 'grid',
    pair: 'ETH-USDT',
    state: 'running',
    settings: 'Range $2,900.00 to $3,500.00, 30 grids',
    startedAt: '2026-10-06T14:10:00Z',
    invested: '1200.00',
    profit: '31.15',
    fills: 77,
    curve: curve(23, 24, 0, 3115, 260),
  },
  {
    id: 'dca-sol',
    kind: 'dca',
    pair: 'SOL-USDT',
    state: 'running',
    settings: '$25.00 every day, up to 30 buys',
    startedAt: '2026-09-28T07:00:00Z',
    invested: '400.00',
    profit: '-6.20',
    fills: 16,
    curve: curve(37, 24, 0, -620, 380),
  },
  {
    id: 'twap-btc',
    kind: 'twap',
    pair: 'BTC-USDT',
    state: 'running',
    settings: 'Buy $1,500.00 over 4 hours, a slice every 10 minutes',
    startedAt: '2026-10-14T06:00:00Z',
    invested: '930.00',
    profit: null,
    fills: 15,
    progressPercent: 62,
    curve: curve(41, 24, 0, 93000, 0),
  },
  {
    id: 'grid-sol',
    kind: 'grid',
    pair: 'SOL-USDT',
    state: 'stopped',
    settings: 'Range $130.00 to $165.00, 20 grids',
    startedAt: '2026-09-20T10:00:00Z',
    endedAt: '2026-10-01T16:45:00Z',
    invested: '800.00',
    profit: '22.80',
    fills: 61,
    curve: curve(53, 24, 0, 2280, 200),
  },
  {
    id: 'dca-btc',
    kind: 'dca',
    pair: 'BTC-USDT',
    state: 'finished',
    settings: '$50.00 every week, 10 buys',
    startedAt: '2026-07-06T08:00:00Z',
    endedAt: '2026-09-07T08:00:00Z',
    invested: '500.00',
    profit: '18.90',
    fills: 10,
    curve: curve(67, 24, 0, 1890, 150),
  },
];

export const botsFixture = definePreviewFixture<SampleBotsRows>('bots', 'Grid, DCA and TWAP bots: sample settings and sample results.', {
  asOf: '2026-10-14T08:00:00Z',
  markets: [
    { pair: 'BTC-USDT', base: 'BTC', price: '64250.00', tick: '0.01' },
    { pair: 'ETH-USDT', base: 'ETH', price: '3180.40', tick: '0.01' },
    { pair: 'SOL-USDT', base: 'SOL', price: '148.62', tick: '0.01' },
  ],
  bots,
  performance: {
    d7: curve(71, 7, 10240, 15305, 300),
    d30: curve(73, 30, 0, 15305, 700),
  },
  defaults: {
    grid: { pair: 'BTC-USDT', low: '60000.00', high: '68000.00', grids: '24', invest: '1000.00' },
    dca: { pair: 'ETH-USDT', perBuy: '25.00', frequency: 'daily', buys: '30', takeProfit: '8' },
    twap: { side: 'buy', pair: 'SOL-USDT', total: '2000.00', hours: '4', intervalMinutes: '10', slippage: '0.30' },
  },
  sampleBalance: '5000.00',
});
