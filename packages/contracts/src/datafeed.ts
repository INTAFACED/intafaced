import { z } from 'zod';
import { decimalString, tradingScheduleSchema, type TradingSchedule } from './instruments.js';

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

/**
 * Bucket width per interval — the SAME fixed widths svc-trade buckets with
 * (exchange-contract TIMEFRAME_MS; services/svc-trade/src/spot/candles.ts):
 * `floor(ts / width) * width`. `1M` is a fixed 30-day bucket, NOT a calendar
 * month. exchange-contract tests assert parity for every interval.
 */
export const DATAFEED_INTERVAL_MS: Readonly<Record<DatafeedInterval, number>> = {
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
  '1M': 2_592_000_000,
};

export const DATAFEED_ERROR_CODES = {
  /** The market catalogue's own code (svc-trade ccxt-errors badSymbol). */
  unknownSymbol: 'trade.market_not_found',
  intervalUnsupported: 'trade.datafeed.interval_unsupported',
  tickSizeUnset: 'trade.datafeed.tick_size_unset',
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

/** Start (epoch ms) of the bucket that contains `atMs`: svc-trade epoch-floor arithmetic, every interval. */
export function bucketStart(interval: DatafeedInterval, atMs: number): number {
  const width = DATAFEED_INTERVAL_MS[interval];
  return Math.floor(atMs / width) * width;
}

// ── Symbol resolve ───────────────────────────────────────────────────────────

/** The listing view the adapter is fed (from /markets + /market-lifecycle). */
export const datafeedListingSchema = z
  .object({
    symbol: z.string().min(1),
    base: z.string().min(1),
    quote: z.string().min(1),
    type: z.enum(['spot', 'swap', 'future', 'option']),
    active: z.boolean(),
    tickSize: decimalString.nullable(),
    /** null = the venue's hours are not published for this listing. */
    schedule: tradingScheduleSchema.nullable(),
  })
  .strict();
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

/** Canonical tick-size → price format (apps/customer chart-data.ts priceFormat is the desk copy). */
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

export const takerFillSchema = z
  .object({
    atMs: z.number().int().nonnegative(),
    /** Engine sequence: open/close order, same as svc-trade candles (two fills in one ms stay deterministic). */
    sequence: z.number().int().nonnegative(),
    price: decimalString,
    amount: decimalString,
  })
  .strict();
export type TakerFill = z.infer<typeof takerFillSchema>;

export const datafeedBarSchema = z
  .object({
    time: z.number().int().nonnegative(),
    open: decimalString,
    high: decimalString,
    low: decimalString,
    close: decimalString,
    volume: decimalString,
    /** null until svc-trade aggregates tick count (cex-spot change). */
    tickCount: z.null(),
    /** null until svc-trade aggregates spread (cex-spot change). */
    spread: z.null(),
  })
  .strict();
export type DatafeedBar = z.infer<typeof datafeedBarSchema>;

function fracDigits(v: string): number {
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

/**
 * Bars from taker fills (same rule as services/svc-trade/src/spot/candles.ts): epoch-floor buckets,
 * open/close by engine sequence. Prices are formatted to the market tick precision and volumes to
 * the lot precision, so output never depends on which fills are in the batch.
 */
export function barsFromFills(
  interval: DatafeedInterval,
  fills: readonly TakerFill[],
  market: { tickSize: string; lotSize: string },
): DatafeedBar[] {
  const pScale = priceFormatFromTick(market.tickSize).pricePrecision;
  const aScale = priceFormatFromTick(market.lotSize).pricePrecision;
  for (const f of fills) {
    const ok = takerFillSchema.safeParse(f);
    if (!ok.success || fracDigits(f.price.replace(/0+$/, '')) > pScale || fracDigits(f.amount.replace(/0+$/, '')) > aScale) {
      throw new DatafeedError(DATAFEED_ERROR_CODES.badFill, 'fill carries a non-decimal value or more precision than the market tick/lot');
    }
  }
  const sorted = [...fills].sort((a, b) => a.sequence - b.sequence);
  const buckets = new Map<number, { o: bigint; h: bigint; l: bigint; c: bigint; v: bigint }>();
  for (const f of sorted) {
    const t = bucketStart(interval, f.atMs);
    const p = toScaled(f.price.includes('.') ? f.price.replace(/0+$/, '').replace(/\.$/, '') : f.price, pScale);
    const a = toScaled(f.amount.includes('.') ? f.amount.replace(/0+$/, '').replace(/\.$/, '') : f.amount, aScale);
    const cur = buckets.get(t);
    if (!cur) buckets.set(t, { o: p, h: p, l: p, c: p, v: a });
    else {
      if (p > cur.h) cur.h = p;
      if (p < cur.l) cur.l = p;
      cur.c = p;
      cur.v += a;
    }
  }
  return [...buckets.entries()]
    .sort(([x], [y]) => x - y)
    .map(([time, b]) => ({
      time,
      open: fromScaled(b.o, pScale),
      high: fromScaled(b.h, pScale),
      low: fromScaled(b.l, pScale),
      close: fromScaled(b.c, pScale),
      volume: fromScaled(b.v, aScale),
      tickCount: null,
      spread: null,
    }));
}

// ── Adapter interface ────────────────────────────────────────────────────────

export const datafeedConfigSchema = z
  .object({
    intervals: z.array(datafeedIntervalSchema).readonly(),
    supportsMarks: z.literal(false),
    supportsTickCount: z.literal(false),
  })
  .strict();
export type DatafeedConfig = z.infer<typeof datafeedConfigSchema>;

export const DATAFEED_CONFIG: DatafeedConfig = { intervals: DATAFEED_INTERVALS, supportsMarks: false, supportsTickCount: false };

export const datafeedQuoteSchema = z
  .object({
    symbol: z.string().min(1),
    last: decimalString.nullable(),
    bid: decimalString.nullable(),
    ask: decimalString.nullable(),
  })
  .strict();
export type DatafeedQuote = z.infer<typeof datafeedQuoteSchema>;

const sessionsScheduleSchema = tradingScheduleSchema.options[1];

export const resolvedSymbolSchema = z
  .object({
    symbol: z.string().min(1),
    base: z.string().min(1),
    quote: z.string().min(1),
    type: z.enum(['spot', 'swap', 'future', 'option']),
    listed: z.boolean(),
    session: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('continuous'), label: z.literal('24/7') }).strict(),
      z.object({ kind: z.literal('sessions'), timezone: z.string().min(3), schedule: sessionsScheduleSchema }).strict(),
      z.object({ kind: z.literal('hours_not_published') }).strict(),
    ]),
    timezone: z.string().nullable(),
    priceFormat: z.object({ pricePrecision: z.number().int().nonnegative(), minMove: decimalString }).strict(),
    intervals: z.array(datafeedIntervalSchema).readonly(),
    hasTickCount: z.literal(false),
  })
  .strict();

/** The interface the desk adapter and developer packages implement against our routes. */
export interface Datafeed {
  onReady(): Promise<DatafeedConfig>;
  resolveSymbol(symbol: string): Promise<ResolvedSymbol>;
  getBars(symbol: string, interval: DatafeedInterval, range: { fromMs: number; toMs: number }): Promise<DatafeedBar[]>;
  subscribeBars(symbol: string, interval: DatafeedInterval, onBar: (bar: DatafeedBar) => void): () => void;
  getQuotes(symbols: readonly string[]): Promise<DatafeedQuote[]>;
}
