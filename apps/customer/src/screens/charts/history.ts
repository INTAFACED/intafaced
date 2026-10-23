/**
 * Older bars for the workbench chart, and "go to date".
 *
 * `/api/v1/ohlcv/:symbol?timeframe&since&limit` returns the NEWEST `limit` buckets at or after `since` (svc-trade
 * spot/candles.ts: `ORDER BY bucket_ms DESC LIMIT`), at most 720 (`OHLC_RECENT_ROW_CAP`; a selection from `since` to now
 * wider than `limit` is refused), and has no end bound. So the deepest history a chart can page to is the last 720
 * buckets of an interval: one read with `since` = 719 buckets before now and limit 720.
 * That depth is stated to the person; going further back needs an end bound on the service (not built), and a date
 * past it is refused in words, never filled with invented bars.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { ohlcvSchema, TIMEFRAME_MS } from '@intafaced/exchange-contract/schemas';
import { forwardFill, type OhlcvRow } from '../../data/derive';
import { useDataEnv } from '../../data/hooks';
import type { Candle } from '../../data/types';
import type { ChartInterval } from '../trade/chart/candles';

/** The service's published cap on one candle read (svc-trade `OHLC_RECENT_ROW_CAP`). */
export const HISTORY_DEPTH = 720;

export type HistoryState =
  | { status: 'idle' }
  | { status: 'loading' }
  /**
   * `earliest` is the first bar the service holds inside the deepest window (null: none). Buckets without trades are
   * absent from the read, so nothing here says whether the market traded before the window: only that it did not
   * between `since` and `earliest`.
   */
  | { status: 'loaded'; bars: Candle[]; earliest: number | null; since: number }
  | { status: 'error'; code?: string };

/** `since` for the deepest window of an interval: the bucket 719 steps before the current one. */
export function deepSince(interval: ChartInterval, nowMs: number): number {
  const step = TIMEFRAME_MS[interval];
  return (Math.floor(nowMs / step) - (HISTORY_DEPTH - 1)) * step;
}

/**
 * Bars older than the loaded window, forward-filled the same way the polled bars are (a quiet bucket repeats the last
 * close, flagged `filled`). Nothing before the first bar the service returned is drawn.
 */
export function olderBars(rows: readonly OhlcvRow[], interval: ChartInterval, oldestLoadedMs: number): Candle[] {
  const step = TIMEFRAME_MS[interval];
  const before = rows.filter((row) => row[0] < oldestLoadedMs);
  if (before.length === 0) return [];
  if (interval === '1w') return before.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5], filled: false }));
  return forwardFill(before, { stepMs: step, nowMs: oldestLoadedMs - step }).filter((c) => c.t < oldestLoadedMs);
}

/** The loaded bars with the older ones in front, never two bars for one time. */
export function withHistory(recent: readonly Candle[], older: readonly Candle[]): readonly Candle[] {
  if (older.length === 0 || recent.length === 0) return recent;
  const first = recent[0]!.t;
  const front = older.filter((c) => c.t < first);
  return front.length === 0 ? recent : [...front, ...recent];
}

export type DateTarget =
  | { kind: 'show'; index: number }
  /** Inside the window but before its first trade: nothing traded between the date and `earliest`. */
  | { kind: 'no-trades-until'; earliest: number }
  /** Older than the deepest window the service serves for this interval. */
  | { kind: 'beyond-depth'; oldestReachable: number }
  | { kind: 'future' };

/** Where a date lands in the bars on the chart. `bars` are oldest first; `oldestReachable` is the deepest window's start. */
export function locateDate(bars: readonly Candle[], targetMs: number, oldestReachable: number, nowMs: number): DateTarget {
  if (targetMs > nowMs) return { kind: 'future' };
  if (targetMs < oldestReachable) return { kind: 'beyond-depth', oldestReachable };
  const first = bars[0];
  if (!first) return { kind: 'beyond-depth', oldestReachable };
  if (targetMs < first.t) return { kind: 'no-trades-until', earliest: first.t };
  let index = bars.length - 1;
  for (let i = 0; i < bars.length; i += 1) {
    if (bars[i]!.t > targetMs) {
      index = Math.max(0, i - 1);
      break;
    }
  }
  return { kind: 'show', index };
}

/** One deep read per market and interval, on demand (scrolling to the oldest bar, or a date before it). */
export function useChartHistory(symbol: string, interval: ChartInterval, oldestLoadedMs: number | null) {
  const env = useDataEnv();
  const [state, setState] = useState<HistoryState>({ status: 'idle' });
  const asked = useRef<Promise<HistoryState> | null>(null);
  // Bumped when the market or interval changes: a read started for the old one is dropped when it returns.
  const generation = useRef(0);
  const oldest = useRef(oldestLoadedMs);
  oldest.current = oldestLoadedMs;
  useEffect(() => {
    generation.current += 1;
    asked.current = null;
    setState({ status: 'idle' });
  }, [symbol, interval]);

  const load = useCallback((): Promise<HistoryState> => {
    if (asked.current) return asked.current;
    const mine = generation.current;
    const nowMs = (env.now ?? Date.now)();
    const since = deepSince(interval, nowMs);
    setState({ status: 'loading' });
    const run = (
      env.api.rest(`/ohlcv/${encodeURIComponent(symbol)}`, z.array(ohlcvSchema), {
        query: { timeframe: interval, since, limit: HISTORY_DEPTH },
      }) as Promise<{ ok: true; data: OhlcvRow[] } | { ok: false; code?: string }>
    )
      .then((result): HistoryState => {
        if (!result.ok) return { status: 'error', code: result.code };
        const rows = [...result.data].sort((a, b) => a[0] - b[0]);
        return { status: 'loaded', bars: olderBars(rows, interval, oldest.current ?? nowMs), earliest: rows[0]?.[0] ?? null, since };
      })
      .catch((): HistoryState => ({ status: 'error' }))
      .then((next) => {
        if (generation.current !== mine) return next;
        // A failed read is not kept, so scrolling back (or the next date) asks again.
        if (next.status === 'error') asked.current = null;
        setState(next);
        return next;
      });
    asked.current = run;
    return run;
  }, [env, symbol, interval]);

  const oldestReachable = useMemo(() => deepSince(interval, (env.now ?? Date.now)()), [env, interval]);
  return { state, load, oldestReachable };
}
