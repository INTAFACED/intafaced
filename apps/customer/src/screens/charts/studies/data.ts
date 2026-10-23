/**
 * The public tape for the volume studies: `GET /api/v1/trades/:symbol` with an explicit limit (the service refuses a
 * request without one). The tape is the latest prints the service keeps, polled like the chart's candles. Prices and
 * amounts stay decimal strings; the study layer reads them. The higher-timeframe bars come from the desk's own candle
 * source (`useChartCandles`), so they are the same candles the desk draws.
 */
import { useMemo } from 'react';
import { z } from 'zod';
import { tradeSchema } from '@intafaced/exchange-contract/schemas';
import { useDataEnv, useSource } from '../../../data/hooks';
import type { DataEnv } from '../../../data/queries';
import { combine, type Source } from '../../../data/source';
import type { Loadable } from '../../../data/types';
import type { Print } from './math';

/** The print count the tape asks for: the service's own maximum, so the profile covers as much of the tape as it keeps. */
export const TAPE_LIMIT = 500;
export const TAPE_POLL_MS = 10_000;

interface TapeResult {
  ok: true;
  data: Array<z.infer<typeof tradeSchema>>;
}

export function tapeSource(env: DataEnv, symbol: string, limit = TAPE_LIMIT): Source<Print[]> {
  const raw = env.poller.source<Array<z.infer<typeof tradeSchema>>>(
    `studies-tape:${symbol}:${limit}`,
    (signal) =>
      env.api.rest(`/trades/${encodeURIComponent(symbol)}`, z.array(tradeSchema), {
        query: { limit },
        signal,
      }) as Promise<TapeResult | { ok: false; reason: string; code?: string; status?: number }>,
    { intervalMs: TAPE_POLL_MS },
  );
  return combine([raw], ([snap]): Loadable<Print[]> => {
    if (snap.status !== 'ready') return snap as Loadable<never>;
    const prints: Print[] = snap.data
      .filter((row) => row.symbol === symbol)
      .map((row) => ({ t: row.timestamp, side: row.side, amount: row.amount, price: row.price }));
    return prints.length === 0 ? { status: 'empty' } : { status: 'ready', data: prints, asOf: snap.asOf };
  });
}

/** The public tape for a market, polled. Mount it only while a study reads the tape. */
export function useTape(symbol: string, limit = TAPE_LIMIT): Loadable<Print[]> {
  const env = useDataEnv();
  return useSource(useMemo(() => tapeSource(env, symbol, limit), [env, symbol, limit]));
}
