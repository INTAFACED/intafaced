import { definePreviewFixture } from './types';

/**
 * SAMPLE data for the copy-trading Preview: a leaderboard of invented traders, what a follow would look like, and the traders a
 * sample account already follows. No real names or real track records. A ratio is a decimal string ("0.1840" is 18.40%); money is a
 * decimal string. See ../README.md.
 */
export type SampleRiskBand = 'low' | 'medium' | 'high';
/** The Copy-Intel agent's verdict on a trader's track record. */
export type SampleCheckStatus = 'verified' | 'warning' | 'pending';

export interface SampleTraderCheck {
  readonly status: SampleCheckStatus;
  /** Max drawdown the trader reports, as a ratio. */
  readonly reportedDrawdown: string;
  /** Max drawdown Copy-Intel measured from the fills, as a ratio. */
  readonly checkedDrawdown: string;
  /** Did the trader's style stay the same? */
  readonly style: 'steady' | 'drifting';
}

export interface SampleTrader {
  readonly id: string;
  /** An invented label such as "Trader A". Never a real person's name. */
  readonly name: string;
  readonly style: string;
  readonly markets: readonly string[];
  readonly risk: SampleRiskBand;
  /** Returns over 7, 30 and 90 days, as ratios. */
  readonly returns: { readonly d7: string; readonly d30: string; readonly d90: string };
  /** Worst fall from a peak in 90 days, as a positive ratio. */
  readonly drawdown: string;
  readonly winRate: string;
  /** Whole number of followers. */
  readonly followers: number;
  /** USD that followers have copied in total. */
  readonly copiedFunds: string;
  /** USD. The least a follower may copy. */
  readonly minCopy: string;
  readonly tradesPerWeek: number;
  readonly avgHold: string;
  /** Trading since (a fixed instant, UTC). */
  readonly since: string;
  /** Value of 100 over the last 30 days, oldest first, as decimal strings. */
  readonly curve: readonly string[];
  readonly check: SampleTraderCheck;
}

export interface SampleFollow {
  readonly trader: string;
  /** USD the sample account copies. */
  readonly amount: string;
  /** Sample profit or loss in USD. */
  readonly pnl: string;
  readonly copiedTrades: number;
  /** USD. Copying stops if the loss reaches this. */
  readonly maxLoss: string;
  readonly status: 'following' | 'paused';
}

export interface SampleCopyRows {
  readonly traders: readonly SampleTrader[];
  readonly following: readonly SampleFollow[];
  readonly defaults: { readonly amount: string; readonly sizing: 'share' | 'fixed'; readonly perTrade: string; readonly maxLoss: string; readonly copyOpen: boolean };
  /** Sample balance the follow form draws on. Labelled "sample" on screen. */
  readonly sampleBalance: string;
}

/** Basis points to a ratio string: 1840 -> "0.1840", -420 -> "-0.0420". Integer arithmetic only. */
function bp(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}${Math.floor(abs / 10000)}.${String(abs % 10000).padStart(4, '0')}`;
}

/** Whole cents to a decimal string. */
function cents(value: number): string {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
}

/** A wobbling line from 100.00 to exactly `100 + endBp/100`. Integer maths and a fixed seed: the same every time. */
function curve(seed: number, endBp: number): readonly string[] {
  const points = 30;
  const wobble = Math.max(120, Math.floor(Math.abs(endBp) / 4));
  let state = seed;
  const values: string[] = [];
  for (let i = 0; i < points; i++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const noise = i === 0 || i === points - 1 ? 0 : (state % (2 * wobble + 1)) - wobble;
    values.push(cents(10000 + Math.trunc((endBp * i) / (points - 1)) + noise));
  }
  return values;
}

interface Row {
  id: string;
  style: string;
  markets: string[];
  risk: SampleRiskBand;
  d7: number;
  d30: number;
  d90: number;
  drawdown: number;
  win: number;
  followers: number;
  funds: string;
  min: string;
  tpw: number;
  hold: string;
  since: string;
  seed: number;
  check: [SampleCheckStatus, number, number, 'steady' | 'drifting'];
}

const rows: readonly Row[] = [
  { id: 'A', style: 'Swing', markets: ['BTC', 'ETH'], risk: 'medium', d7: 310, d30: 1840, d90: 4120, drawdown: 820, win: 6400, followers: 1284, funds: '842300.00', min: '50.00', tpw: 6, hold: '2 days', since: '2025-03-04T00:00:00Z', seed: 101, check: ['verified', 820, 820, 'steady'] },
  { id: 'B', style: 'Trend', markets: ['BTC'], risk: 'low', d7: 120, d30: 970, d90: 2480, drawdown: 410, win: 5800, followers: 2310, funds: '1620500.00', min: '100.00', tpw: 3, hold: '5 days', since: '2024-11-18T00:00:00Z', seed: 202, check: ['verified', 410, 430, 'steady'] },
  { id: 'C', style: 'Scalping', markets: ['ETH', 'SOL'], risk: 'high', d7: 640, d30: 3260, d90: 5100, drawdown: 2140, win: 5200, followers: 764, funds: '298700.00', min: '25.00', tpw: 58, hold: '20 minutes', since: '2025-06-22T00:00:00Z', seed: 303, check: ['warning', 900, 2140, 'drifting'] },
  { id: 'D', style: 'Grid', markets: ['BTC', 'SOL'], risk: 'low', d7: 80, d30: 520, d90: 1390, drawdown: 360, win: 7100, followers: 986, funds: '512400.00', min: '75.00', tpw: 24, hold: '9 hours', since: '2025-01-12T00:00:00Z', seed: 404, check: ['verified', 360, 360, 'steady'] },
  { id: 'E', style: 'Breakout', markets: ['SOL', 'XRP'], risk: 'high', d7: -280, d30: 1210, d90: 2750, drawdown: 1730, win: 4600, followers: 431, funds: '143900.00', min: '50.00', tpw: 12, hold: '14 hours', since: '2025-08-30T00:00:00Z', seed: 505, check: ['verified', 1730, 1760, 'steady'] },
  { id: 'F', style: 'Swing', markets: ['ETH'], risk: 'medium', d7: 190, d30: 730, d90: 1860, drawdown: 940, win: 5900, followers: 1522, funds: '964100.00', min: '50.00', tpw: 5, hold: '3 days', since: '2024-09-09T00:00:00Z', seed: 606, check: ['verified', 940, 950, 'steady'] },
  { id: 'G', style: 'Carry', markets: ['BTC', 'ETH', 'USDT'], risk: 'low', d7: 40, d30: 290, d90: 860, drawdown: 220, win: 8100, followers: 3047, funds: '2284600.00', min: '200.00', tpw: 2, hold: '9 days', since: '2024-05-27T00:00:00Z', seed: 707, check: ['verified', 220, 220, 'steady'] },
  { id: 'H', style: 'Trend', markets: ['BTC', 'SOL'], risk: 'medium', d7: 260, d30: 1090, d90: 1540, drawdown: 1180, win: 5500, followers: 612, funds: '207800.00', min: '50.00', tpw: 7, hold: '2 days', since: '2025-04-15T00:00:00Z', seed: 808, check: ['verified', 1180, 1190, 'steady'] },
  { id: 'I', style: 'Scalping', markets: ['BTC'], risk: 'medium', d7: 150, d30: 640, d90: 1720, drawdown: 790, win: 6200, followers: 355, funds: '98200.00', min: '25.00', tpw: 41, hold: '35 minutes', since: '2025-09-14T00:00:00Z', seed: 909, check: ['pending', 790, 790, 'steady'] },
  { id: 'J', style: 'Breakout', markets: ['ETH', 'XRP'], risk: 'high', d7: -520, d30: -310, d90: 1980, drawdown: 2860, win: 4300, followers: 218, funds: '61400.00', min: '25.00', tpw: 9, hold: '1 day', since: '2025-10-02T00:00:00Z', seed: 1010, check: ['warning', 1500, 2860, 'drifting'] },
];

const traders: readonly SampleTrader[] = rows.map((row) => ({
  id: row.id.toLowerCase(),
  name: `Trader ${row.id}`,
  style: row.style,
  markets: row.markets,
  risk: row.risk,
  returns: { d7: bp(row.d7), d30: bp(row.d30), d90: bp(row.d90) },
  drawdown: bp(row.drawdown),
  winRate: bp(row.win),
  followers: row.followers,
  copiedFunds: row.funds,
  minCopy: row.min,
  tradesPerWeek: row.tpw,
  avgHold: row.hold,
  since: row.since,
  curve: curve(row.seed, row.d30),
  check: { status: row.check[0], reportedDrawdown: bp(row.check[1]), checkedDrawdown: bp(row.check[2]), style: row.check[3] },
}));

export const copyFixture = definePreviewFixture<SampleCopyRows>('copy', 'Copy trading: sample traders, sample stats and a sample follow.', {
  traders,
  following: [
    { trader: 'a', amount: '800.00', pnl: '46.20', copiedTrades: 31, maxLoss: '120.00', status: 'following' },
    { trader: 'e', amount: '500.00', pnl: '-12.40', copiedTrades: 14, maxLoss: '75.00', status: 'following' },
    { trader: 'h', amount: '300.00', pnl: '9.10', copiedTrades: 8, maxLoss: '60.00', status: 'paused' },
  ],
  defaults: { amount: '1000.00', sizing: 'share', perTrade: '100.00', maxLoss: '150.00', copyOpen: false },
  sampleBalance: '5000.00',
});
