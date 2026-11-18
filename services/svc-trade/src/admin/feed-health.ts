/**
 * Market feed health for the founder console (C-ops-01 (a), C-embed-feed-ops-03 feed journal; J-charts-desk-18 #1 #2).
 *
 *   admin.feedHealth.list     every spot market's candle stream: last tick, age, state (admin:read)
 *   admin.feedHealth.market   one market's row, its candle gaps in a window, and its feed event journal (admin:read)
 *
 * The candle stream is what the chart draws: 1-minute buckets of the public taker tape with seeded fills left out
 * (spot/candles.ts, SD-3). A market's last tick is its newest such fill. Its age is judged against the owner's two ages
 * (C-ops-04; row d115, 17 Nov 2026: delayed and stale are the owner's two ages, the same on every screen): past the
 * stale age (`staleAgeSeconds`) the stream reads `stale`; past the delayed age (`delayedBoundarySeconds`) but not the
 * stale one it reads `delayed`. While the stale age is blank no stream is judged stale: the state is
 * `threshold_not_set`, and the age is still shown. No number here is a default.
 *
 * The journal is written by the feed watcher (`runFeedWatchTick`), never by a person: a `drop` when a stream passes the
 * stale age, a `reconnect` when a tick arrives after a drop. Each row says when, why, and that the actor is the system.
 * It is append-only and read-only on the page. The watcher ticks every FEED_WATCH_INTERVAL_MS; while the stale age is
 * blank it writes nothing, and the page says so.
 *
 * Nothing here moves money or imports a ledger write: these are reads of the trade tape.
 */
import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import { requireOperator, TradeOpsError } from './common.js';
import { readChartScalars } from './chart-owner-values.js';

export const FEED_STATES = ['live', 'delayed', 'stale', 'no_ticks', 'threshold_not_set'] as const;
export type FeedState = (typeof FEED_STATES)[number];

/** The gap window a caller may ask for, in minutes. The page shows its own value in the field; this is a schema bound. */
export const FEED_GAP_WINDOW_MAX_MINUTES = 1_440;
/** Most gap runs and journal rows one read returns, newest first. A bound on the answer, not a business value. */
export const FEED_LIST_MAX = 200;
const MAX_MARKETS = 500;
const BUCKET_MS = 60_000;

/**
 * How often the watcher looks, in ms. An operational tick, not an owner value: what it judges against is the owner's
 * stale age, and a blank stale age writes nothing. A transition's `at` is the stream's own time, so the tick only bounds
 * how soon a row appears (within this many ms).
 */
export const FEED_WATCH_INTERVAL_MS = 5_000;

export const FEED_SYMBOL_UNKNOWN = 'trade.feed.symbol_unknown' as const;

export interface FeedRow {
  readonly symbol: string;
  readonly test: boolean;
  /** Newest candle tick (non-seeded taker fill), ISO, or null when the market has none. */
  readonly lastTickAt: string | null;
  /** Whole seconds from the last tick to `asOf`, or null with no tick. */
  readonly ageSeconds: number | null;
  readonly state: FeedState;
}

export interface FeedWatcherView {
  /** How often the watcher looks, in ms. */
  readonly intervalMs: number;
  /** False while the owner's stale age is blank: the watcher judges nothing and writes no row. */
  readonly writing: boolean;
}

export interface FeedListView {
  readonly asOf: string;
  /** The owner's stale age in seconds, or null while it is not set. */
  readonly staleAgeSeconds: number | null;
  /** The owner's delayed age in seconds, or null while it is not set. */
  readonly delayedAgeSeconds: number | null;
  readonly watcher: FeedWatcherView;
  readonly markets: readonly FeedRow[];
}

export interface FeedGap {
  /** Start of the first empty 1-minute bucket, ISO. */
  readonly from: string;
  /** End of the last empty bucket (exclusive), ISO. */
  readonly to: string;
  readonly minutes: number;
}

export interface FeedEvent {
  readonly id: string;
  readonly kind: 'drop' | 'reconnect';
  /** When it happened on the stream: the moment the stale age passed (drop) or the first tick back (reconnect). */
  readonly at: string;
  readonly observedAt: string;
  readonly reason: string;
  readonly actor: 'system';
}

export interface FeedMarketView extends FeedListView {
  readonly market: FeedRow;
  readonly gapWindowMinutes: number;
  /** Empty closed 1-minute buckets since the window start (or the first tick, if later), newest first. */
  readonly gaps: readonly FeedGap[];
  readonly gapsTruncated: boolean;
  /** Newest first. */
  readonly journal: readonly FeedEvent[];
}

export interface FeedHealthDeps {
  readonly sql: Sql;
  readonly now: () => Date;
}

type TickRow = { symbol: string; test: boolean; market_id: string; last_tick: Date | null };

async function readTicks(sql: Sql, symbol?: string): Promise<TickRow[]> {
  return sql<TickRow[]>`
    SELECT m.id::text AS market_id, m.symbol, m.test, t.last_tick
      FROM trade.markets m
      LEFT JOIN LATERAL (
        SELECT max(f.ts) AS last_tick
          FROM trade.fills f
          JOIN trade.orders o ON o.id = f.order_id
          JOIN trade.orders c ON c.id = f.counter_order_id
         WHERE f.market_id = m.id AND f.liquidity = 'taker' AND o.seeded = false AND c.seeded = false
      ) t ON true
     WHERE m.kind = 'spot' AND m.paper = false
       ${symbol === undefined ? sql`` : sql`AND m.symbol = ${symbol}`}
     ORDER BY m.symbol
     LIMIT ${MAX_MARKETS}`;
}

/** The owner's two ages in seconds (C-ops-04, row d115); null is not set. */
export interface FeedAges {
  readonly staleSeconds: number | null;
  readonly delayedSeconds: number | null;
}

/** The owner's two ages as svc-trade's charts owner values hold them. */
async function readAges(sql: Sql): Promise<FeedAges> {
  const { values } = await readChartScalars(sql);
  return { staleSeconds: values.staleAgeSeconds, delayedSeconds: values.delayedBoundarySeconds };
}

/** The state of one stream at `now`, judged against the owner's two ages. Pure. */
export function feedStateOf(lastTick: Date | null, ages: FeedAges, now: Date): Omit<FeedRow, 'symbol' | 'test'> {
  if (lastTick === null) return { lastTickAt: null, ageSeconds: null, state: 'no_ticks' };
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - lastTick.getTime()) / 1000));
  const { staleSeconds, delayedSeconds } = ages;
  const state: FeedState =
    staleSeconds === null
      ? 'threshold_not_set'
      : ageSeconds > staleSeconds
        ? 'stale'
        : delayedSeconds !== null && ageSeconds > delayedSeconds
          ? 'delayed'
          : 'live';
  return { lastTickAt: lastTick.toISOString(), ageSeconds, state };
}

/**
 * The empty closed 1-minute buckets in [start, now), where start is the window start or the first tick's bucket, whichever
 * is later. `filled` holds the bucket starts (epoch ms) that have a candle. Runs of empty buckets are returned newest first.
 * Pure.
 */
export function candleGaps(
  filled: ReadonlySet<number>,
  firstTickMs: number | null,
  windowStartMs: number,
  nowMs: number,
): { gaps: FeedGap[]; truncated: boolean } {
  if (firstTickMs === null) return { gaps: [], truncated: false };
  const start = Math.max(Math.floor(windowStartMs / BUCKET_MS), Math.floor(firstTickMs / BUCKET_MS)) * BUCKET_MS;
  const openBucket = Math.floor(nowMs / BUCKET_MS) * BUCKET_MS;
  const runs: FeedGap[] = [];
  let runStart: number | null = null;
  const close = (end: number) => {
    if (runStart === null) return;
    runs.push({
      from: new Date(runStart).toISOString(),
      to: new Date(end).toISOString(),
      minutes: (end - runStart) / BUCKET_MS,
    });
    runStart = null;
  };
  for (let bucket = start; bucket < openBucket; bucket += BUCKET_MS) {
    if (filled.has(bucket)) close(bucket);
    else runStart ??= bucket;
  }
  close(openBucket);
  runs.reverse();
  return { gaps: runs.slice(0, FEED_LIST_MAX), truncated: runs.length > FEED_LIST_MAX };
}

type EventRow = { id: string; kind: 'drop' | 'reconnect'; at: Date; observed_at: Date; reason: string; actor: 'system' };

function eventView(row: EventRow): FeedEvent {
  return {
    id: row.id,
    kind: row.kind,
    at: row.at.toISOString(),
    observedAt: row.observed_at.toISOString(),
    reason: row.reason,
    actor: row.actor,
  };
}

export class FeedHealthDesk {
  constructor(private readonly deps: FeedHealthDeps) {}

  async list(principal: Principal): Promise<FeedListView> {
    requireOperator(principal);
    const { sql } = this.deps;
    const ages = await readAges(sql);
    const now = this.deps.now();
    const rows = await readTicks(sql);
    return {
      asOf: now.toISOString(),
      staleAgeSeconds: ages.staleSeconds,
      delayedAgeSeconds: ages.delayedSeconds,
      watcher: { intervalMs: FEED_WATCH_INTERVAL_MS, writing: ages.staleSeconds !== null },
      markets: rows.map((row) => ({ symbol: row.symbol, test: row.test, ...feedStateOf(row.last_tick, ages, now) })),
    };
  }

  async market(principal: Principal, input: { symbol: string; gapWindowMinutes: number }): Promise<FeedMarketView> {
    requireOperator(principal);
    const { sql } = this.deps;
    const window = input.gapWindowMinutes;
    if (!Number.isInteger(window) || window < 1 || window > FEED_GAP_WINDOW_MAX_MINUTES) {
      throw new TradeOpsError('trade.feed.gap_window_invalid', `the gap window is 1 to ${FEED_GAP_WINDOW_MAX_MINUTES} minutes`);
    }
    const ages = await readAges(sql);
    const now = this.deps.now();
    const [row] = await readTicks(sql, input.symbol);
    if (!row) throw new TradeOpsError(FEED_SYMBOL_UNKNOWN, `no spot market ${input.symbol}`);
    const windowStart = new Date(now.getTime() - window * BUCKET_MS);
    const [first] = await sql<Array<{ first_tick: Date | null }>>`
      SELECT min(f.ts) AS first_tick
        FROM trade.fills f
        JOIN trade.orders o ON o.id = f.order_id
        JOIN trade.orders c ON c.id = f.counter_order_id
       WHERE f.market_id = ${row.market_id}::uuid AND f.liquidity = 'taker' AND o.seeded = false AND c.seeded = false`;
    const buckets = await sql<Array<{ bucket_ms: string }>>`
      SELECT DISTINCT (floor(extract(epoch from f.ts) * 1000 / ${BUCKET_MS}::bigint)::bigint * ${BUCKET_MS}::bigint)::text AS bucket_ms
        FROM trade.fills f
        JOIN trade.orders o ON o.id = f.order_id
        JOIN trade.orders c ON c.id = f.counter_order_id
       WHERE f.market_id = ${row.market_id}::uuid AND f.liquidity = 'taker' AND o.seeded = false AND c.seeded = false
         AND f.ts >= ${windowStart}`;
    const filled = new Set(buckets.map((b) => Number(b.bucket_ms)));
    const { gaps, truncated } = candleGaps(filled, first?.first_tick?.getTime() ?? null, windowStart.getTime(), now.getTime());
    const journal = await sql<EventRow[]>`
      SELECT id::text AS id, kind, at, observed_at, reason, actor
        FROM trade.feed_events WHERE symbol = ${row.symbol}
       ORDER BY id DESC LIMIT ${FEED_LIST_MAX}`;
    const market = { symbol: row.symbol, test: row.test, ...feedStateOf(row.last_tick, ages, now) };
    return {
      asOf: now.toISOString(),
      staleAgeSeconds: ages.staleSeconds,
      delayedAgeSeconds: ages.delayedSeconds,
      watcher: { intervalMs: FEED_WATCH_INTERVAL_MS, writing: ages.staleSeconds !== null },
      markets: [market],
      market,
      gapWindowMinutes: window,
      gaps,
      gapsTruncated: truncated,
      journal: journal.map(eventView),
    };
  }
}

export interface FeedWatchResult {
  readonly checked: number;
  readonly drops: number;
  readonly reconnects: number;
  /** True when the owner's stale age is blank: nothing was judged and nothing was written. */
  readonly boundaryUnset: boolean;
}

/**
 * One pass of the feed watcher. For each spot market with a tick: a stream past the stale age whose last journal row is not
 * a drop gets a `drop` dated when the stale age passed; a stream within the stale age whose last row is a drop gets a
 * `reconnect` dated at its newest tick. Each market is decided under its own advisory lock, so two replicas never write
 * the same transition twice. A blank stale age writes nothing.
 */
export async function runFeedWatchTick(sql: Sql, now: Date = new Date()): Promise<FeedWatchResult> {
  const ages = await readAges(sql);
  const boundarySeconds = ages.staleSeconds;
  if (boundarySeconds === null) return { checked: 0, drops: 0, reconnects: 0, boundaryUnset: true };
  const rows = await readTicks(sql);
  let drops = 0;
  let reconnects = 0;
  let checked = 0;
  for (const row of rows) {
    if (row.last_tick === null) continue;
    checked += 1;
    const { state, ageSeconds } = feedStateOf(row.last_tick, ages, now);
    const lastTick = row.last_tick;
    const wrote = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`trade.feed_events:${row.symbol}`}, 0))`;
      const [last] = await tx<Array<{ kind: string; at: Date; boundary_seconds: number }>>`
        SELECT kind, at, boundary_seconds FROM trade.feed_events WHERE symbol = ${row.symbol} ORDER BY id DESC LIMIT 1`;
      // The drop's own last tick: its time less the stale age it was judged by, so a stale age changed since still finds it.
      const droppedTickMs = last?.kind === 'drop' ? last.at.getTime() - last.boundary_seconds * 1000 : null;
      if (state === 'stale' && last?.kind !== 'drop') {
        const at = new Date(lastTick.getTime() + boundarySeconds * 1000);
        await tx`
          INSERT INTO trade.feed_events (symbol, kind, at, observed_at, reason, actor, age_seconds, boundary_seconds)
          VALUES (${row.symbol}, 'drop', ${at}, ${now},
                  ${`No candle tick for ${ageSeconds} s, past the owner's ${boundarySeconds} s stale age; last tick ${lastTick.toISOString()}`},
                  'system', ${ageSeconds}, ${boundarySeconds})`;
        return 'drop';
      }
      if ((state === 'live' || state === 'delayed') && droppedTickMs !== null && lastTick.getTime() > droppedTickMs) {
        const quietSeconds = Math.round((lastTick.getTime() - droppedTickMs) / 1000);
        await tx`
          INSERT INTO trade.feed_events (symbol, kind, at, observed_at, reason, actor, age_seconds, boundary_seconds)
          VALUES (${row.symbol}, 'reconnect', ${lastTick}, ${now},
                  ${`Candle ticks resumed after ${quietSeconds} s without one`}, 'system', ${ageSeconds}, ${boundarySeconds})`;
        return 'reconnect';
      }
      return null;
    });
    if (wrote === 'drop') drops += 1;
    if (wrote === 'reconnect') reconnects += 1;
  }
  return { checked, drops, reconnects, boundaryUnset: false };
}
