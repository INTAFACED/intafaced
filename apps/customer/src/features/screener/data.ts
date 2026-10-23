import { useMemo } from 'react';
import { useDataEnv, useSource } from '../../data/hooks';
import { ohlcvFetcher } from '../../data/fetchers';
import type { Loadable, Timeframe } from '../../data/types';
import type { ChangeTimeframe } from './model';

const CLOSES_POLL_MS = 60_000;
/** Markets read at once for closes. The screen reads only the markets its other filters kept, never the whole listing. */
const CLOSES_CONCURRENCY = 4;

/**
 * The close one full period back, per market, for the 1 h or 1 d change column. 1 h reads 61 one-minute candles and takes the
 * oldest close (60 minutes back); 1 d reads 25 one-hour candles and takes the oldest close (24 hours back). A market whose read
 * fails or is short reads null for that market: its change cell shows no data, and the others still show.
 * Returns an empty record when no timeframe needs candles or no symbols are asked for.
 */
export function useCloses(symbols: readonly string[], timeframe: ChangeTimeframe): Loadable<Record<string, string | null>> {
  const env = useDataEnv();
  const wanted = timeframe === '1h' || timeframe === '1d' ? timeframe : null;
  const key = [...new Set(symbols)].sort().join(',');
  return useSource(
    useMemo(
      () =>
        env.poller.source<Record<string, string | null>>(
          `screener-closes:${wanted ?? 'none'}:${key}`,
          async (signal) => {
            if (!wanted || !key) return { ok: true, data: {} };
            const [interval, limit]: [Timeframe, number] = wanted === '1h' ? ['1m', 61] : ['1h', 25];
            const list = key.split(',');
            const out: Record<string, string | null> = {};
            let next = 0;
            const worker = async () => {
              while (next < list.length) {
                const symbol = list[next]!;
                next += 1;
                const result = await ohlcvFetcher(env.api, symbol, interval, limit)(signal);
                out[symbol] = result.ok && result.data.length >= limit ? result.data[0]![4] : null;
              }
            };
            await Promise.all(Array.from({ length: Math.min(CLOSES_CONCURRENCY, list.length) }, worker));
            return { ok: true, data: out };
          },
          { intervalMs: CLOSES_POLL_MS },
        ),
      [env, wanted, key],
    ),
  );
}
