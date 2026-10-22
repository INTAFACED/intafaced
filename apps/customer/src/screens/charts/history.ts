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
  /** `earliest` is the first bar the service holds inside the deepest window; `reachedStart` when trading began inside it. */
  | { status: 'loaded'; bars: Candle[]; earliest: number | null; reachedStart: boolean }
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
  /** Before the first trade in the window: the chart moves to `earliest` and says so. */
  | { kind: 'before-start'; earliest: number }
  /** Older than the deepest window the service serves for this interval. */
  | { kind: 'beyond-depth'; oldestReachable: number }
  | { kind: 'future' };

/** Where a date lands in the bars on the chart. `bars` are oldest first; `reachedStart` means the first bar is the market's first. */
export function locateDate(
  bars: readonly Candle[],
  targetMs: number,
  reachedStart: boolean,
  oldestReachable: number,
  nowMs: number,
): DateTarget {
  if (targetMs > nowMs) return { kind: 'future' };
  const first = bars[0];
  if (!first || targetMs < first.t) {
    if (first && reachedStart) return { kind: 'before-start', earliest: first.t };
    return { kind: 'beyond-depth', oldestReachable };
  }
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
  const oldest = useRef(oldestLoadedMs);
  oldest.current = oldestLoadedMs;
  useEffect(() => {
    asked.current = null;
    setState({ status: 'idle' });
  }, [symbol, interval]);

  const load = useCallback((): Promise<HistoryState> => {
    if (asked.current) return asked.current;
    const nowMs = (env.now ?? Date.now)();
    const since = deepSince(interval, nowMs);
    setState({ status: 'loading' });
    const run = (
      env.api.rest(`/ohlcv/${encodeURIComponent(symbol)}`, z.array(ohlcvSchema), {
        query: { timeframe: interval, since, limit: HISTORY_DEPTH },
      }) as Promise<{ ok: true; data: OhlcvRow[] } | { ok: false; code?: string }>
    ).then((result): HistoryState => {
      if (!result.ok) {
        asked.current = null;
        return { status: 'error', code: result.code };
      }
      const rows = [...result.data].sort((a, b) => a[0] - b[0]);
      const earliest = rows[0]?.[0] ?? null;
      // Fewer rows than the window can hold, with the first one after `since`: trading began inside the window.
      const reachedStart = earliest === null || (rows.length < HISTORY_DEPTH && earliest > since);
      const bars = olderBars(rows, interval, oldest.current ?? nowMs);
      return { status: 'loaded', bars, earliest, reachedStart };
    });
    asked.current = run;
    void run.then(setState, () => setState({ status: 'error' }));
    return run;
  }, [env, symbol, interval]);

  const oldestReachable = useMemo(() => deepSince(interval, (env.now ?? Date.now)()), [env, interval]);
  return { state, load, oldestReachable };
}
