/**
 * Rolling 24 h ticker statistics + hourly sparkline, from real taker fills.
 *
 * Same source and the same exclusions as the candles and the public tape
 * (`candles.ts`, `trade-service.publicTape`): `trade.fills` where
 * `liquidity = 'taker'`, never a fill that touches a seeded order (SD-3).
 * Nothing is modelled. The only thing carried forward is a price that really
 * printed — a silent hour repeats the previous hour's real close.
 *
 * ONE QUERY FOR ALL MARKETS. `queryTickerStats` takes every market id of a
 * request and answers with a single statement (one scan of the last 24 h on
 * `fills_market_ts_idx`, plus one indexed lookup per market for the price
 * carried into the window). The caller never loops queries over markets.
 *
 * All money is exact: numerics travel as text, are parsed to scaled bigints,
 * and VWAP / percentage are bigint divisions (`div`, half-up). No floats.
 */
import type { Sql } from 'postgres';
import { div, parseAmount, type Amount } from '@intafaced/ledger-client';

export const TICKER_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SPARKLINE_BUCKET_MS = 60 * 60 * 1000;
export const SPARKLINE_POINTS = 24;

/** Server-side ticker facts for one market. All-null `open…quoteVolume` = no trade in the window. */
export interface TickerStats24h {
  readonly open: Amount | null;
  readonly high: Amount | null;
  readonly low: Amount | null;
  readonly vwap: Amount | null;
  readonly baseVolume: Amount | null;
  readonly quoteVolume: Amount | null;
  /**
   * Start of the span the stats describe, unix ms. `now − 24 h` when the market
   * has traded at or before that instant (a full window); otherwise the first
   * trade's timestamp, so the UI can say "since HH:mm". Null = never traded.
   */
  readonly windowStart: number | null;
  /** Up to 24 hourly closes, oldest first. Empty when the market has never traded. */
  readonly sparkline: readonly Amount[];
}

type StatsRow = {
  market_id: string;
  has_window: boolean;
  open: string | null;
  high: string | null;
  low: string | null;
  base_volume: string | null;
  quote_volume: string | null;
  first_ts_ms: string | null;
  carry_price: string | null;
  hours: Array<[string, string]> | null;
};

/**
 * Pure assembly of the sparkline: slots `[firstSlot … currentHour]`, each the
 * close of that hour if it traded, else the previous slot's close. The first
 * slot is the carried-in price (the last print before the window), or — for a
 * market younger than the window — the hour of its first trade. Never null,
 * never invented: a younger market gets a SHORTER line, not a padded one.
 */
export function buildSparkline(opts: { nowMs: number; carryIn: Amount | null; closesByHour: ReadonlyMap<number, Amount> }): Amount[] {
  const currentHour = Math.floor(opts.nowMs / SPARKLINE_BUCKET_MS);
  const windowFirstHour = currentHour - (SPARKLINE_POINTS - 1);
  let first = windowFirstHour;
  // The window starts mid-hour (now − 24 h) but the first slot is the next whole
  // hour, so prints of the partial hour before it still precede slot 0: the
  // latest of those wins over the older carried-in price.
  let prev: Amount | null = opts.carryIn;
  let prevHour = Number.NEGATIVE_INFINITY;
  for (const [h, close] of opts.closesByHour) {
    if (h < windowFirstHour && h > prevHour) {
      prevHour = h;
      prev = close;
    }
  }
  if (prev === null) {
    const hours = [...opts.closesByHour.keys()].filter((h) => h >= windowFirstHour && h <= currentHour);
    if (hours.length === 0) return [];
    first = Math.min(...hours);
  }
  const out: Amount[] = [];
  for (let h = first; h <= currentHour; h += 1) {
    const close = opts.closesByHour.get(h) ?? prev;
    if (close === null || close === undefined) continue;
    out.push(close);
    prev = close;
  }
  return out;
}

/** Stats for every market id, one SQL statement. Missing ids still get an (empty) entry. */
export async function queryTickerStats(sql: Sql, marketIds: readonly string[], nowMs: number): Promise<Map<string, TickerStats24h>> {
  const result = new Map<string, TickerStats24h>();
  if (marketIds.length === 0) return result;

  const sinceMs = nowMs - TICKER_WINDOW_MS;
  const since = new Date(sinceMs);
  const now = new Date(nowMs);
  const ids = [...new Set(marketIds)];

  // Hour index (epoch ms / 1h) matches the candle bucketing in `candles.ts`.
  // `base` is every real taker fill of the last 24 h for all requested markets.
  const rows = await sql<StatsRow[]>`
    WITH base AS (
      SELECT f.market_id, f.price, f.qty, f.quote_amount, f.sequence, f.ts,
             floor(extract(epoch from f.ts) * 1000 / ${SPARKLINE_BUCKET_MS}::bigint)::bigint AS hour
        FROM trade.fills f
        INNER JOIN trade.orders o ON o.id = f.order_id
        INNER JOIN trade.orders c ON c.id = f.counter_order_id
       WHERE f.market_id = ANY(${ids}::uuid[])
         AND f.liquidity = 'taker'
         AND o.seeded = false
         AND c.seeded = false
         AND f.ts >= ${since}
         AND f.ts <= ${now}
    ),
    stats AS (
      SELECT market_id,
             (array_agg(price ORDER BY sequence ASC))[1] AS open,
             max(price)                                  AS high,
             min(price)                                  AS low,
             sum(qty)                                    AS base_volume,
             sum(quote_amount)                           AS quote_volume,
             floor(extract(epoch from min(ts)) * 1000)   AS first_ts_ms
        FROM base
       GROUP BY market_id
    ),
    hourly AS (
      SELECT market_id,
             json_agg(json_build_array(hour::text, close::text) ORDER BY hour) AS hours
        FROM (
          SELECT market_id, hour, (array_agg(price ORDER BY sequence DESC))[1] AS close
            FROM base
           GROUP BY market_id, hour
        ) h
       GROUP BY market_id
    )
    SELECT m.id::text                          AS market_id,
           (s.market_id IS NOT NULL)           AS has_window,
           s.open::text                        AS open,
           s.high::text                        AS high,
           s.low::text                         AS low,
           s.base_volume::text                 AS base_volume,
           s.quote_volume::text                AS quote_volume,
           s.first_ts_ms::text                 AS first_ts_ms,
           carry.price::text                   AS carry_price,
           hr.hours                            AS hours
      FROM unnest(${ids}::uuid[]) AS m(id)
      LEFT JOIN stats  s  ON s.market_id  = m.id
      LEFT JOIN hourly hr ON hr.market_id = m.id
      LEFT JOIN LATERAL (
        -- The last real print BEFORE the window: what a silent first hour repeats,
        -- and the proof that this market has a full 24 h of history behind it.
        SELECT f.price
          FROM trade.fills f
          INNER JOIN trade.orders o ON o.id = f.order_id
          INNER JOIN trade.orders c ON c.id = f.counter_order_id
         WHERE f.market_id = m.id
           AND f.liquidity = 'taker'
           AND o.seeded = false
           AND c.seeded = false
           AND f.ts < ${since}
         ORDER BY f.ts DESC, f.sequence DESC
         LIMIT 1
      ) carry ON true
  `;

  for (const row of rows) {
    const carryIn = row.carry_price === null ? null : parseAmount(row.carry_price);
    const closesByHour = new Map<number, Amount>();
    for (const [hour, close] of row.hours ?? []) closesByHour.set(Number(hour), parseAmount(close));
    const sparkline = buildSparkline({ nowMs, carryIn, closesByHour });

    // A fill exactly at `since` counts as "at or after now−24h" (>=), so a market
    // whose only history starts there still reports a window that starts there.
    const firstTradeMs = row.first_ts_ms === null ? null : Number(row.first_ts_ms);
    const windowStart = carryIn !== null ? sinceMs : firstTradeMs;

    if (!row.has_window) {
      result.set(row.market_id, {
        open: null,
        high: null,
        low: null,
        vwap: null,
        baseVolume: null,
        quoteVolume: null,
        windowStart,
        sparkline,
      });
      continue;
    }
    const baseVolume = parseAmount(row.base_volume ?? '0');
    const quoteVolume = parseAmount(row.quote_volume ?? '0');
    result.set(row.market_id, {
      open: row.open === null ? null : parseAmount(row.open),
      high: row.high === null ? null : parseAmount(row.high),
      low: row.low === null ? null : parseAmount(row.low),
      vwap: baseVolume > 0n ? div(quoteVolume, baseVolume) : null,
      baseVolume,
      quoteVolume,
      windowStart,
      sparkline,
    });
  }
  return result;
}

/**
 * Short in-process cache over `queryTickerStats`, per market id.
 *
 * A Home page, a markets list and a ticker strip all poll `/tickers` every few
 * seconds; the 24 h aggregate does not change meaningfully in that time. Only
 * ids that are missing or expired go to the database — in ONE statement — so a
 * warm cache costs zero queries and a cold one costs exactly one.
 */
export function createTickerStatsReader(
  sql: Sql,
  opts: { ttlMs: number; maxEntries?: number },
): (marketIds: readonly string[], nowMs: number) => Promise<Map<string, TickerStats24h>> {
  const maxEntries = opts.maxEntries ?? 2000;
  const cache = new Map<string, { at: number; stats: TickerStats24h }>();

  return async (marketIds, nowMs) => {
    const out = new Map<string, TickerStats24h>();
    const stale: string[] = [];
    for (const id of new Set(marketIds)) {
      const hit = cache.get(id);
      if (hit && nowMs - hit.at >= 0 && nowMs - hit.at < opts.ttlMs) out.set(id, hit.stats);
      else stale.push(id);
    }
    if (stale.length > 0) {
      const fresh = await queryTickerStats(sql, stale, nowMs);
      if (cache.size + fresh.size > maxEntries) cache.clear();
      for (const [id, stats] of fresh) {
        cache.set(id, { at: nowMs, stats });
        out.set(id, stats);
      }
    }
    return out;
  };
}

/** change ÷ open × 100, exact (bigint, half-up at 18 places). Null when open is zero. */
export function percentageOf(change: Amount, open: Amount): Amount | null {
  if (open === 0n) return null;
  return div(change * 100n, open);
}
