/**
 * What the chart says about the data it draws: one chip, the age of the newest trade, and a banner for the states that
 * stop a person reading the chart as live. Pure, so the rules are tested apart from React.
 *
 * Three clocks meet here. Trade stamps and the lifecycle's times are the server's, so a trade's age is taken on the
 * server clock (the client clock plus the offset read from /time). Poll ages (the candles, the lifecycle, the book halt)
 * are on the client clock, because the poller stamps them when it reads. The chart forward-fills quiet intervals up to now
 * (apps/customer/src/screens/trade/chart/candles.ts), so a dead feed still draws bars at the time of reading: the age
 * shown is the newest executed trade's, never the bars'. A candle feed whose last good read is older than two polls is
 * stale; a failed read is down.
 */
import type { Loadable } from '../../data/types';

export type DataClass = 'real_time' | 'delayed' | 'end_of_day';

export type ChartDataChip =
  | 'loading'
  | 'live'
  | 'quiet'
  | 'delayed'
  | 'end_of_day'
  | 'stale'
  | 'down'
  | 'halted'
  | 'not_open'
  | 'lifecycle_unavailable'
  | 'book_unavailable'
  | 'no_data'
  | 'class_unset'
  | 'class_unread'
  | 'threshold_unset'
  | 'tick_unread';

export type FeedState = 'loading' | 'connected' | 'empty' | 'stale' | 'down';

/** The local test stack writes this marker into every market's lifecycle evidence (tooling/scripts/local-test-gates.mjs). */
export const TEST_EVIDENCE_PREFIX = 'local-test:';

/** The lifecycle and the book halt are read on this poll. Shared with market-state.ts. */
export const STATE_POLL_MS = 10_000;

export interface LifecycleView {
  state: string;
  /** When the state took effect, in epoch ms (null when the route names no time). Server clock. */
  effectiveAt: number | null;
  evidenceRefs: readonly string[];
}

/** The matching book's halt, as svc-trade reads it from matching: this market, and the whole venue. */
export interface BookHaltView {
  halted: boolean;
  venueHalted: boolean;
  /** When matching halted this book / the venue (epoch ms); null when not in force or the route names no time. */
  haltedSinceMs: number | null;
  venueHaltedSinceMs: number | null;
}

export interface OwnerValuesView {
  dataClass: DataClass | null;
  delayedBoundarySeconds: number | null;
}

export interface StatusInputs {
  /** The client clock, epoch ms. Poll ages are measured against it. */
  now: number;
  /** The server clock minus the client clock, in ms, from /time. A trade's age is judged on the server clock. */
  serverClock: Loadable<number>;
  owner: Loadable<OwnerValuesView>;
  lifecycle: Loadable<LifecycleView>;
  /** The matching book's halt state. An unreadable one refuses the chart as live; it is never read as open. */
  bookHalt: Loadable<BookHaltView>;
  /** The candle read. Only its status and `asOf` (the last good read) are used. */
  candles: Loadable<unknown>;
  /** The newest executed trade's time in epoch ms (server clock), or null when the market has none. */
  lastTrade: Loadable<number | null>;
  /** The candle poll interval in ms; a read older than two intervals (and a second of slack) is stale. */
  pollIntervalMs: number;
}

export interface DataStatus {
  chip: ChartDataChip;
  feed: FeedState;
  /** Whole seconds since the newest trade, on the server clock, when it is read and the market has one. */
  ageSeconds: number | null;
  /** Whole seconds since the candles were last read successfully, when they have been. */
  feedAgeSeconds: number | null;
  /** The newest trade's time, epoch ms, when read. */
  lastTradeMs: number | null;
  /** The lifecycle state the market is in, when read. */
  state: string | null;
  /** When the halt or not-open state took effect (epoch ms), or null when the route names no time. */
  stateSinceMs: number | null;
  /** The owner's delayed boundary in seconds, when set. */
  thresholdSeconds: number | null;
  /** Order entry from the chart is refused until the market state and the book are read and open. */
  orderEntry: 'open' | 'refused';
  test: boolean;
}

/** Two polls and a second of slack: a single missed poll is not yet stale. */
export const feedStaleAfterMs = (pollIntervalMs: number): number => pollIntervalMs * 2 + 1_000;

/** A poll that was read, but whose last good read is older than the state poll allows, is not current. */
const isCurrent = <T>(read: Loadable<T>, now: number): read is Extract<Loadable<T>, { status: 'ready' }> =>
  read.status === 'ready' && now - read.asOf <= feedStaleAfterMs(STATE_POLL_MS);

export type TradeRefusal = 'loading' | 'lifecycle_unavailable' | 'halted' | 'not_open' | 'book_unavailable' | 'book_halted';

/**
 * Why order entry is refused for this market now, or null when the state and the book both read open and current. Used by
 * the chart's status and by the trade link, so the two never disagree. A state still loading is refused as loading (the
 * link is disabled until it is read); an unreadable or stale state or book is refused, never read as open.
 */
export function tradeRefusal(
  lifecycle: Loadable<LifecycleView>,
  bookHalt: Loadable<BookHaltView>,
  now: number,
): { code: TradeRefusal; state: string | null } | null {
  if (lifecycle.status === 'loading') return { code: 'loading', state: null };
  if (!isCurrent(lifecycle, now)) return { code: 'lifecycle_unavailable', state: null };
  if (lifecycle.data.state === 'HALTED') return { code: 'halted', state: 'HALTED' };
  if (lifecycle.data.state !== 'OPEN') return { code: 'not_open', state: lifecycle.data.state };
  if (bookHalt.status === 'loading') return { code: 'loading', state: null };
  if (!isCurrent(bookHalt, now)) return { code: 'book_unavailable', state: null };
  if (bookHalt.data.halted || bookHalt.data.venueHalted) return { code: 'book_halted', state: null };
  return null;
}

function feedOf(candles: Loadable<unknown>, pollIntervalMs: number, now: number): FeedState {
  if (candles.status === 'loading') return 'loading';
  if (candles.status === 'error' || candles.status === 'refused') return 'down';
  if (candles.status === 'empty') return 'empty';
  return now - candles.asOf >= feedStaleAfterMs(pollIntervalMs) ? 'stale' : 'connected';
}

export function dataStatus(input: StatusInputs): DataStatus {
  const { now, serverClock, owner, lifecycle, bookHalt, candles, lastTrade, pollIntervalMs } = input;
  const lastTradeMs = lastTrade.status === 'ready' ? lastTrade.data : null;
  const offsetMs = serverClock.status === 'ready' ? serverClock.data : null;
  const serverNow = offsetMs === null ? null : now + offsetMs;
  const ageSeconds = lastTradeMs === null || serverNow === null ? null : Math.max(0, Math.floor((serverNow - lastTradeMs) / 1000));
  const feed = feedOf(candles, pollIntervalMs, now);
  const feedAgeSeconds = candles.status === 'ready' ? Math.max(0, Math.floor((now - candles.asOf) / 1000)) : null;
  const life = lifecycle.status === 'ready' ? lifecycle.data : null;
  const base = {
    feed,
    feedAgeSeconds,
    ageSeconds,
    lastTradeMs,
    state: life?.state ?? null,
    stateSinceMs: life?.effectiveAt ?? null,
    thresholdSeconds: owner.status === 'ready' ? owner.data.delayedBoundarySeconds : null,
    test: life !== null && life.evidenceRefs.some((ref) => ref.startsWith(TEST_EVIDENCE_PREFIX)),
  };
  const result = (value: ChartDataChip, orderEntry: 'open' | 'refused' = 'open'): DataStatus => ({ ...base, chip: value, orderEntry });

  // Whether the market may be traded decides first: a market whose state or book is not read, halted or not open is never live.
  const refusal = tradeRefusal(lifecycle, bookHalt, now);
  if (refusal !== null) {
    if (refusal.code === 'loading') return result('loading', 'refused');
    if (refusal.code === 'lifecycle_unavailable') return result('lifecycle_unavailable', 'refused');
    if (refusal.code === 'book_unavailable') return result('book_unavailable', 'refused');
    if (refusal.code === 'not_open') return result('not_open', 'refused');
    if (refusal.code === 'book_halted' && bookHalt.status === 'ready') {
      // The lifecycle reads OPEN here, so its time is when it opened: the halt's own time is the earliest named time of the
      // halts in force (the book's, the venue's), or unknown when matching names none.
      const book = bookHalt.data;
      const named = [book.halted ? book.haltedSinceMs : null, book.venueHalted ? book.venueHaltedSinceMs : null].filter(
        (ms): ms is number => ms !== null,
      );
      return { ...result('halted', 'refused'), stateSinceMs: named.length > 0 ? Math.min(...named) : null };
    }
    return result('halted', 'refused');
  }

  if (feed === 'down') return result('down');
  if (feed === 'stale') return result('stale');
  if (feed === 'loading') return result('loading');
  if (feed === 'empty') return result('no_data');

  if (owner.status === 'loading') return result('loading');
  if (owner.status !== 'ready') return result('class_unread');
  const dataClass = owner.data.dataClass;
  if (dataClass === null) return result('class_unset');
  if (dataClass === 'end_of_day') return result('end_of_day');
  if (dataClass === 'delayed') return result('delayed');

  // Real-time: the newest trade's age on the server clock against the owner's boundary. A quiet market (no trade inside the
  // boundary) is quiet, not delayed: nothing is behind. A blank boundary claims neither live nor quiet.
  if (lastTrade.status === 'loading' || serverClock.status === 'loading') return result('loading');
  if (lastTrade.status !== 'ready' || serverClock.status !== 'ready') return result('tick_unread');
  if (lastTradeMs === null) return result('no_data');
  const threshold = owner.data.delayedBoundarySeconds;
  if (threshold === null) return result('threshold_unset');
  return result((ageSeconds ?? 0) > threshold ? 'quiet' : 'live');
}
