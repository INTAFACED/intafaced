import { z } from 'zod';
import { tradingScheduleSchema, type TradingSchedule } from './instruments.js';

/**
 * DATAFEED CONTRACT (C-embed-feed-ops-01) — the typed interface a chart adapter
 * (desk `/charts/:symbol`, `/trade/spot/:pair`, developer packages) codes against.
 *
 * The shape follows the embed-library datafeed (config, resolve symbol, bars,
 * subscribe bars, quotes); the DATA comes only from our own public routes:
 *   - config        ← GET /api/v1/capabilities
 *   - resolveSymbol ← GET /api/v1/markets + GET /api/v1/market-lifecycle/:symbol
 *   - getBars       ← GET /api/v1/ohlcv/:symbol
 *   - subscribeBars ← svc-ws candle channel (services/svc-ws/src/mux/candle-hub.ts)
 * The chart holds no data of its own. No new service.
 *
 * Intervals are OUR identifiers (`TIMEFRAMES`, packages/exchange-contract). The
 * reference's numeric resolution strings ("1", "60", "1D") are not adopted, and
 * an interval outside the list refuses — there is no nearest-interval fallback.
 * `packages/exchange-contract` asserts DATAFEED_INTERVALS === TIMEFRAMES in its
 * tests (it depends on this package, not the other way round).
 *
 * Money is decimal strings on the wire, scaled bigint in arithmetic. No `number`
 * here holds a price or a size.
 */

export const DATAFEED_INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '3d', '1w', '1M'] as const;
export type DatafeedInterval = (typeof DATAFEED_INTERVALS)[number];
export const datafeedIntervalSchema = z.enum(DATAFEED_INTERVALS);

/** Fixed-width bucket length; `1M` is calendar-month and bucketed by UTC month start. */
const FIXED_INTERVAL_MS: Readonly<Record<Exclude<DatafeedInterval, '1M'>, number>> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '3d': 259_200_000,
  '1w': 604_800_000,
};

export const DATAFEED_ERROR_CODES = {
  unknownSymbol: 'trade.datafeed.unknown_symbol',
  intervalUnsupported: 'trade.datafeed.interval_unsupported',
  tickSizeUnset: 'trade.datafeed.tick_size_unset',
  noFills: 'trade.datafeed.no_fills',
  badFill: 'trade.datafeed.bad_fill',
} as const;
export type DatafeedErrorCode = (typeof DATAFEED_ERROR_CODES)[keyof typeof DATAFEED_ERROR_CODES];

/** Typed refusal. Never carries a substituted value. */
export class DatafeedError extends Error {
  constructor(
    readonly code: DatafeedErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DatafeedError';
  }
}

/** Parse an interval identifier; anything outside the contract refuses (no fallback). */
export function parseDatafeedInterval(input: unknown): DatafeedInterval {
  const parsed = datafeedIntervalSchema.safeParse(input);
  if (!parsed.success) {
    throw new DatafeedError(DATAFEED_ERROR_CODES.intervalUnsupported, `interval ${JSON.stringify(input)} is not in the datafeed contract`);
  }
  return parsed.data;
}

/** Start (epoch ms, UTC) of the bucket that contains `atMs`. */
export function bucketStart(interval: DatafeedInterval, atMs: number): number {
  if (interval === '1M') {
    const d = new Date(atMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  const width = FIXED_INTERVAL_MS[interval];
  return Math.floor(atMs / width) * width;
}

// ── Symbol resolve ───────────────────────────────────────────────────────────

const decimalString = z.string().regex(/^\d+(\.\d+)?$/, 'decimal string');

/** The listing view the adapter is fed (from /markets + /market-lifecycle). */
export const datafeedListingSchema = z.object({
  symbol: z.string().min(1),
  base: z.string().min(1),
  quote: z.string().min(1),
  type: z.enum(['spot', 'swap', 'future', 'option']),
  active: z.boolean(),
  tickSize: decimalString.nullable(),
  /** null = the venue's hours are not published for this listing. */
  schedule: tradingScheduleSchema.nullable(),
});
export type DatafeedListing = z.infer<typeof datafeedListingSchema>;

export type DatafeedSession =
  | { kind: 'continuous'; label: '24/7' }
  | { kind: 'sessions'; timezone: string; schedule: Extract<TradingSchedule, { kind: 'sessions' }> }
  /** Never assumed 24/7: the chart draws no session separators. */
  | { kind: 'hours_not_published' };

export interface DatafeedPriceFormat {
  /** Decimal places drawn, from the tick size. */
  pricePrecision: number;
  /** Smallest price move, the tick size as a decimal string. */
  minMove: string;
}

export interface ResolvedSymbol {
  symbol: string;
  base: string;
  quote: string;
  type: DatafeedListing['type'];
  listed: boolean;
  session: DatafeedSession;
  /** IANA zone of the session clock; null when hours are not published. Continuous markets use UTC. */
  timezone: string | null;
  priceFormat: DatafeedPriceFormat;
  intervals: readonly DatafeedInterval[];
  /** Tick count / spread on bars need the cex-spot svc-trade change; false until it lands. */
  hasTickCount: false;
}

export function priceFormatFromTick(tickSize: string | null | undefined): DatafeedPriceFormat {
  if (tickSize == null || tickSize.trim() === '' || !/^\d+(\.\d+)?$/.test(tickSize) || /^0+(\.0+)?$/.test(tickSize)) {
    throw new DatafeedError(DATAFEED_ERROR_CODES.tickSizeUnset, 'tick size is unset — refuse to invent a price format');
  }
  const frac = tickSize.includes('.') ? tickSize.split('.')[1]!.replace(/0+$/, '') : '';
  return { pricePrecision: frac.length, minMove: tickSize };
}

/**
 * One object: listing, trading hours (or 24/7), timezone and price format.
 * `listing` undefined/null = unknown symbol → typed refusal.
 */
export function resolveSymbol(symbol: string, listing: DatafeedListing | null | undefined): ResolvedSymbol {
  if (!listing || listing.symbol !== symbol) {
    throw new DatafeedError(DATAFEED_ERROR_CODES.unknownSymbol, `symbol ${symbol} is not listed`);
  }
  const priceFormat = priceFormatFromTick(listing.tickSize);
  let session: DatafeedSession;
  let timezone: string | null;
  if (listing.schedule === null) {
    session = { kind: 'hours_not_published' };
    timezone = null;
  } else if (listing.schedule.kind === 'continuous') {
    session = { kind: 'continuous', label: '24/7' };
    timezone = 'Etc/UTC';
  } else {
    session = { kind: 'sessions', timezone: listing.schedule.timezone, schedule: listing.schedule };
    timezone = listing.schedule.timezone;
  }
  return {
    symbol: listing.symbol,
    base: listing.base,
    quote: listing.quote,
    type: listing.type,
    listed: listing.active,
    session,
    timezone,
    priceFormat,
    intervals: DATAFEED_INTERVALS,
    hasTickCount: false,
  };
}

// ── Bars ─────────────────────────────────────────────────────────────────────

export interface TakerFill {
  atMs: number;
  price: string;
  amount: string;
}

export interface DatafeedBar {
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  /** null until svc-trade aggregates tick count (cex-spot change). */
  tickCount: null;
  /** null until svc-trade aggregates spread (cex-spot change). */
  spread: null;
}

function scaleOf(v: string): number {
  const i = v.indexOf('.');
  return i < 0 ? 0 : v.length - i - 1;
}
function toScaled(v: string, scale: number): bigint {
  const [w, f = ''] = v.split('.');
  return BigInt(w! + f.padEnd(scale, '0'));
}
function fromScaled(n: bigint, scale: number): string {
  if (scale === 0) return n.toString();
  const s = n.toString().padStart(scale + 1, '0');
  return `${s.slice(0, -scale)}.${s.slice(-scale)}`;
}

/** Bars from taker fills (same rule as services/svc-trade/src/spot/candles.ts): one bar per bucket, time order. */
export function barsFromFills(interval: DatafeedInterval, fills: readonly TakerFill[]): DatafeedBar[] {
  for (const f of fills) {
    if (!Number.isFinite(f.atMs) || !/^\d+(\.\d+)?$/.test(f.price) || !/^\d+(\.\d+)?$/.test(f.amount)) {
      throw new DatafeedError(DATAFEED_ERROR_CODES.badFill, 'fill carries a non-decimal price or amount');
    }
  }
  const pScale = Math.max(0, ...fills.map((f) => scaleOf(f.price)));
  const aScale = Math.max(0, ...fills.map((f) => scaleOf(f.amount)));
  const sorted = [...fills].sort((a, b) => a.atMs - b.atMs);
  const out: DatafeedBar[] = [];
  let cur: { time: number; o: bigint; h: bigint; l: bigint; c: bigint; v: bigint } | null = null;
  const flush = () => {
    if (cur)
      out.push({
        time: cur.time,
        open: fromScaled(cur.o, pScale),
        high: fromScaled(cur.h, pScale),
        low: fromScaled(cur.l, pScale),
        close: fromScaled(cur.c, pScale),
        volume: fromScaled(cur.v, aScale),
        tickCount: null,
        spread: null,
      });
  };
  for (const f of sorted) {
    const t = bucketStart(interval, f.atMs);
    const p = toScaled(f.price, pScale);
    const a = toScaled(f.amount, aScale);
    if (!cur || cur.time !== t) {
      flush();
      cur = { time: t, o: p, h: p, l: p, c: p, v: a };
    } else {
      if (p > cur.h) cur.h = p;
      if (p < cur.l) cur.l = p;
      cur.c = p;
      cur.v += a;
    }
  }
  flush();
  return out;
}

// ── Adapter interface ────────────────────────────────────────────────────────

export interface DatafeedConfig {
  intervals: readonly DatafeedInterval[];
  supportsMarks: false;
  supportsTickCount: false;
}

export const DATAFEED_CONFIG: DatafeedConfig = { intervals: DATAFEED_INTERVALS, supportsMarks: false, supportsTickCount: false };

export interface DatafeedQuote {
  symbol: string;
  last: string | null;
  bid: string | null;
  ask: string | null;
}

/** The interface the desk adapter and developer packages implement against our routes. */
export interface Datafeed {
  onReady(): Promise<DatafeedConfig>;
  resolveSymbol(symbol: string): Promise<ResolvedSymbol>;
  getBars(symbol: string, interval: DatafeedInterval, range: { fromMs: number; toMs: number }): Promise<DatafeedBar[]>;
  subscribeBars(symbol: string, interval: DatafeedInterval, onBar: (bar: DatafeedBar) => void): () => void;
  getQuotes(symbols: readonly string[]): Promise<DatafeedQuote[]>;
}
