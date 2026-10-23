/**
 * What the chart says about the data it draws: one chip, the age of the newest trade, and a banner for the states that
 * stop a person reading the chart as live. Pure, so the rules are tested apart from React.
 *
 * The age is the age of the newest executed trade (the public tape), never the age of the bars: the chart forward-fills
 * quiet intervals up to now (apps/customer/src/screens/trade/chart/candles.ts), so a dead feed still draws bars at the
 * time of reading. A candle feed whose last good read is older than two polls is stale; a failed read is down.
 */
import type { Loadable } from '../../data/types';

export type DataClass = 'real_time' | 'delayed' | 'end_of_day';

export type ChartDataChip =
  | 'loading'
  | 'live'
  | 'delayed'
  | 'end_of_day'
  | 'stale'
  | 'down'
  | 'halted'
  | 'not_open'
  | 'lifecycle_unavailable'
  | 'no_data'
  | 'class_unset'
  | 'class_unread'
  | 'threshold_unset'
  | 'tick_unread';

export type FeedState = 'loading' | 'connected' | 'empty' | 'stale' | 'down';

/** The local test stack writes this marker into every market's lifecycle evidence (tooling/scripts/local-test-gates.mjs). */
export const TEST_EVIDENCE_PREFIX = 'local-test:';

export interface LifecycleView {
  state: string;
  /** When the state took effect, in epoch ms (null when the route names no time). */
  effectiveAt: number | null;
  evidenceRefs: readonly string[];
}

export interface OwnerValuesView {
  dataClass: DataClass | null;
  delayedBoundarySeconds: number | null;
}

export interface StatusInputs {
  now: number;
  owner: Loadable<OwnerValuesView>;
  lifecycle: Loadable<LifecycleView>;
  /** The candle read. Only its status and `asOf` (the last good read) are used. */
  candles: Loadable<unknown>;
  /** The newest executed trade's time in epoch ms, or null when the market has none. */
  lastTrade: Loadable<number | null>;
  /** The candle poll interval in ms; a read older than two intervals (and a second of slack) is stale. */
  pollIntervalMs: number;
}

export interface DataStatus {
  chip: ChartDataChip;
  feed: FeedState;
  /** Whole seconds since the newest trade, when it is read and the market has one. */
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
  /** Order entry from the chart is refused until the market state is read and OPEN. */
  orderEntry: 'open' | 'refused';
  test: boolean;
}

/** Two polls and a second of slack: a single missed poll is not yet stale. */
export const feedStaleAfterMs = (pollIntervalMs: number): number => pollIntervalMs * 2 + 1_000;

function feedOf(candles: Loadable<unknown>, pollIntervalMs: number, now: number): FeedState {
  if (candles.status === 'loading') return 'loading';
  if (candles.status === 'error' || candles.status === 'refused') return 'down';
  if (candles.status === 'empty') return 'empty';
  return now - candles.asOf >= feedStaleAfterMs(pollIntervalMs) ? 'stale' : 'connected';
}

export function dataStatus(input: StatusInputs): DataStatus {
  const { now, owner, lifecycle, candles, lastTrade, pollIntervalMs } = input;
  const lastTradeMs = lastTrade.status === 'ready' ? lastTrade.data : null;
  const ageSeconds = lastTradeMs === null ? null : Math.max(0, Math.floor((now - lastTradeMs) / 1000));
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

  // Whether the market may be traded decides first: a market whose state is not read, halted or not open is never live.
  if (lifecycle.status === 'loading') return result('loading', 'refused');
  if (!life) return result('lifecycle_unavailable', 'refused');
  if (life.state === 'HALTED') return result('halted', 'refused');
  if (life.state !== 'OPEN') return result('not_open', 'refused');

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

  // Real-time: the newest trade's age against the owner's boundary. A blank boundary claims neither live nor delayed.
  if (lastTrade.status === 'loading') return result('loading');
  if (lastTrade.status !== 'ready') return result('tick_unread');
  if (lastTradeMs === null) return result('no_data');
  const threshold = owner.data.delayedBoundarySeconds;
  if (threshold === null) return result('threshold_unset');
  return result((ageSeconds ?? 0) > threshold ? 'delayed' : 'live');
}
