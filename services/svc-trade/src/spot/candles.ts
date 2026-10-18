/**
 * Spot OHLCV — aggregate from real taker fills only (A-TRADE-SPOT-1).
 *
 * Source of truth: `trade.fills` where `liquidity = 'taker'`, excluding any
 * fill that touches a seeded order (SD-3). Empty buckets are absent, never
 * zero-filled. Nothing is modelled, interpolated, or carried forward.
 *
 * REST `fetchOHLCV` always reads live via `queryCandlesFromFills`. The optional
 * materialization job (`candle-jobs.ts`, default OFF) may copy *closed* buckets
 * into `trade.spot_candles` for durable consumers — it never invents rows.
 */
import type { Sql } from 'postgres';
import { TIMEFRAME_MS, timeframeSchema, type Timeframe } from '@intafaced/exchange-contract';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { TradeError, type Candle } from './types.js';

/** Blank / non-integer / out of 1..1000 fill-aggregation limit refuse. Never invent 500. */
export const TRADE_CANDLES_FILL_LIMIT_UNSET = 'trade.candles_fill_limit_unset' as const;
export const CANDLES_FILL_LIMIT_MAX = 1000;

/**
 * A request is answered in full for the window it asked for, or refused.
 * The cap is the request's own limit. TradeService also refuses a limit above
 * {@link OHLC_RECENT_ROW_CAP} before SQL. A legal limit does not shrink the
 * window into a partial series.
 */
export const TRADE_CANDLES_RANGE_POINT_CAP = 'trade.candles_range_point_cap' as const;

/** Kraken returns at most the 720 most recent OHLC rows. Older rows are absent, never invented. */
export const OHLC_RECENT_ROW_CAP = 720;

export class CandlesFillLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof TRADE_CANDLES_FILL_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'CandlesFillLimitUnsetError';
  }
}

export interface QueryCandlesOpts {
  marketId: string;
  timeframe: Timeframe;
  /**
   * Max buckets to return (newest kept, then oldest→newest).
   * Unset/null/out of 1..1000 → typed refuse (never invent 500). Owner may pass 500.
   */
  limit?: number | null;
  /** Inclusive lower bound on fill `ts` (unix ms). */
  sinceMs?: number;
}

/** Buckets a [sinceMs, endMs) selection would cover. End at or before start is an empty selection. */
export function candleRangePointCount(timeframe: Timeframe, sinceMs: number, endMs: number): number {
  const span = TIMEFRAME_MS[timeframe];
  if (!Number.isInteger(sinceMs) || !Number.isInteger(endMs) || endMs <= sinceMs) return 0;
  const delta = endMs - sinceMs;
  return Math.floor((delta + span - 1) / span);
}

/** Refuse the whole request when the selection is over the request's own limit. */
export function assertCandleRangeWithinCap(timeframe: Timeframe, sinceMs: number, endMs: number, cap: number): void {
  const points = candleRangePointCount(timeframe, sinceMs, endMs);
  if (points > cap) {
    throw new TradeError(`candle selection would return ${points} points, over the published cap of ${cap}`, TRADE_CANDLES_RANGE_POINT_CAP);
  }
}

export interface ExportedCandle extends Candle {
  /** False while the bucket is still open. The current timeframe stays in the export. */
  readonly committed: boolean;
}

/**
 * OHLC export. The last row may be the current open bucket (`committed: false`).
 * The 720-row slice is a defensive guard. TradeService.candles refuses a limit
 * over that cap before this can run. Missing buckets stay missing.
 */
export function exportOhlcv(candles: readonly Candle[], timeframe: Timeframe, nowMs: number): ExportedCandle[] {
  const span = TIMEFRAME_MS[timeframe];
  const tagged = candles.map((candle) => ({
    openTimeMs: candle.openTimeMs,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    committed: candle.openTimeMs + span <= nowMs,
  }));
  if (tagged.length <= OHLC_RECENT_ROW_CAP) return tagged;
  return tagged.slice(tagged.length - OHLC_RECENT_ROW_CAP);
}

/** Owner-published fill window. Missing / null / non-int / out of 1..max refuses. Never invent 500. */
export function publishedFillCandleLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > CANDLES_FILL_LIMIT_MAX) {
    throw new CandlesFillLimitUnsetError('candles fill limit is unset — refuse to invent 500', TRADE_CANDLES_FILL_LIMIT_UNSET);
  }
  return value;
}

/**
 * Candles for a market, aggregated in SQL from the public taker tape.
 *
 * Bucketing is epoch-floor arithmetic (not `date_bin`) so it runs on the
 * declared Postgres floor. Open/close use engine `sequence`, not wall `ts`,
 * so two fills in the same millisecond stay deterministic.
 */
export async function queryCandlesFromFills(sql: Sql, opts: QueryCandlesOpts): Promise<Candle[]> {
  const capped = publishedFillCandleLimit(opts.limit);
  const spanMs = TIMEFRAME_MS[opts.timeframe];
  const sinceDate = opts.sinceMs !== undefined ? new Date(opts.sinceMs) : undefined;

  type CandleRow = { bucket_ms: string; open: string; high: string; low: string; close: string; volume: string };

  // `bucket_ms` is bigint ms returned as text by postgres.js — Number is exact
  // for timestamps for the next ~285,000 years (not money).
  const bucketExpr = sql`(floor(extract(epoch from ts) * 1000 / ${spanMs}::bigint)::bigint * ${spanMs}::bigint)`;

  // SD-3: exclude fills involving any seeded order.
  const rows = await sql<CandleRow[]>`
    SELECT bucket_ms::text                                              AS bucket_ms,
           (array_agg(price ORDER BY sequence ASC))[1]                  AS open,
           max(price)                                                   AS high,
           min(price)                                                   AS low,
           (array_agg(price ORDER BY sequence DESC))[1]                 AS close,
           sum(qty)                                                     AS volume
      FROM (
        SELECT ${bucketExpr} AS bucket_ms, f.price, f.qty, f.sequence
          FROM trade.fills f
          INNER JOIN trade.orders o ON o.id = f.order_id
          INNER JOIN trade.orders c ON c.id = f.counter_order_id
         WHERE f.market_id = ${opts.marketId}
           AND f.liquidity = 'taker'
           AND o.seeded = false
           AND c.seeded = false
           ${sinceDate ? sql`AND f.ts >= ${sinceDate}` : sql``}
      ) AS binned
     GROUP BY bucket_ms
     -- Newest buckets are the ones a chart opens on; LIMIT keeps those.
     ORDER BY bucket_ms DESC
     LIMIT ${capped}
  `;

  return rows
    .map((row) => ({
      openTimeMs: Number(row.bucket_ms),
      open: parseAmount(row.open),
      high: parseAmount(row.high),
      low: parseAmount(row.low),
      close: parseAmount(row.close),
      volume: parseAmount(row.volume),
    }))
    .reverse(); // CCXT fetchOHLCV: oldest → newest
}

/**
 * Non-seeded taker volume in [from, to). Same SD-3 exclusion as candles.
 * Empty tape → 0, never invented.
 */
export async function queryTakerVolumeFromFills(sql: Sql, opts: { marketId: string; from: Date; to: Date }): Promise<Amount> {
  if (opts.to.getTime() <= opts.from.getTime()) return 0n;
  const rows = await sql<Array<{ volume: string | null }>>`
    SELECT coalesce(sum(f.qty), 0)::text AS volume
      FROM trade.fills f
      INNER JOIN trade.orders o ON o.id = f.order_id
      INNER JOIN trade.orders c ON c.id = f.counter_order_id
     WHERE f.market_id = ${opts.marketId}
       AND f.liquidity = 'taker'
       AND o.seeded = false
       AND c.seeded = false
       AND f.ts >= ${opts.from}
       AND f.ts < ${opts.to}
  `;
  return parseAmount(rows[0]?.volume ?? '0');
}

/**
 * Persist only *closed* buckets with volume > 0.
 *
 * The open (current) bucket is skipped: materializing a half-formed OHLC and
 * serving it later as complete would invent a close that never finished.
 * Empty buckets are never written — a gap stays a gap.
 *
 * @returns number of rows upserted
 */
export async function materializeClosedCandles(
  sql: Sql,
  opts: {
    marketId: string;
    timeframe: Timeframe;
    candles: readonly Candle[];
    nowMs?: number;
  },
): Promise<number> {
  const spanMs = TIMEFRAME_MS[opts.timeframe];
  const nowMs = opts.nowMs ?? Date.now();
  let written = 0;

  for (const candle of opts.candles) {
    // Open bucket still accepting fills — do not freeze it.
    if (candle.openTimeMs + spanMs > nowMs) continue;
    // Zero / negative volume is not a real print.
    if (candle.volume <= 0n) continue;

    await sql`
      INSERT INTO trade.spot_candles (
        market_id, timeframe, open_time_ms,
        open, high, low, close, volume
      ) VALUES (
        ${opts.marketId},
        ${opts.timeframe},
        ${candle.openTimeMs},
        ${formatAmount(candle.open)},
        ${formatAmount(candle.high)},
        ${formatAmount(candle.low)},
        ${formatAmount(candle.close)},
        ${formatAmount(candle.volume)}
      )
      ON CONFLICT (market_id, timeframe, open_time_ms) DO UPDATE SET
        open   = EXCLUDED.open,
        high   = EXCLUDED.high,
        low    = EXCLUDED.low,
        close  = EXCLUDED.close,
        volume = EXCLUDED.volume
    `;
    written += 1;
  }

  return written;
}

/** Comma-separated market UUIDs. Empty → [] (never invent a market list). */
export function parseCandleMarketIds(raw: string | undefined): string[] {
  if (raw == null || !raw.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Comma-separated timeframes. Blank / unset / all-invalid → [] (never invent `1m`).
 * Invalid tokens are dropped, not coerced into fakes. Owner may pass `1m` explicitly.
 */
export function parseCandleTimeframes(raw: string | undefined): Timeframe[] {
  if (raw == null || !raw.trim()) return [];
  const out: Timeframe[] = [];
  for (const part of raw.split(',')) {
    const t = part.trim();
    if (!t) continue;
    const parsed = timeframeSchema.safeParse(t);
    if (parsed.success && !out.includes(parsed.data)) out.push(parsed.data);
  }
  return out;
}
