import { useMemo } from 'react';
import { useDataEnv, useSource } from '../../data/hooks';
import { ohlcvFetcher } from '../../data/fetchers';
import type { Loadable, Timeframe } from '../../data/types';
import type { ChangeTimeframe } from './model';

const CLOSES_POLL_MS = 60_000;

/**
 * The close one bar back, per market, for the 1 h or 1 d change column (the public candle read, two bars). A market whose read
 * fails or has fewer than two bars reads null for that market: its change cell shows no data, and the others still show.
 * Returns an empty record when no timeframe needs candles.
 */
export function useCloses(symbols: readonly string[], timeframe: ChangeTimeframe): Loadable<Record<string, string | null>> {
  const env = useDataEnv();
  const wanted = timeframe === '1h' || timeframe === '1d' ? (timeframe as Timeframe) : null;
  const key = [...new Set(symbols)].sort().join(',');
  return useSource(
    useMemo(
      () =>
        env.poller.source<Record<string, string | null>>(
          `screener-closes:${wanted ?? 'none'}:${key}`,
          async (signal) => {
            if (!wanted || !key) return { ok: true, data: {} };
            const pairs = await Promise.all(
              key.split(',').map(async (symbol) => {
                const result = await ohlcvFetcher(env.api, symbol, wanted, 2)(signal);
                const close = result.ok && result.data.length >= 2 ? result.data[result.data.length - 2]![4] : null;
                return [symbol, close] as const;
              }),
            );
            return { ok: true, data: Object.fromEntries(pairs) };
          },
          { intervalMs: CLOSES_POLL_MS },
        ),
      [env, wanted, key],
    ),
  );
}
