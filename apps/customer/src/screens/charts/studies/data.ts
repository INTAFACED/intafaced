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

/**
 * The funding the venue published on our listed perpetual on the chart's base asset (J-charts-desk-04 #6):
 * `GET /api/v1/venue/funding-history?base=&since=`, public. The rate is a decimal string, a fraction per interval.
 * A venue that publishes none, or a base with no listed perpetual, answers a refusal the study names.
 */
export const FUNDING_POLL_MS = 60_000;
/** How far back the funding study asks: the venue's rows over the last day. */
export const FUNDING_LOOKBACK_MS = 24 * 3_600_000;

const fundingSchema = z.object({
  symbol: z.string(),
  intervalSeconds: z.number().nullable(),
  test: z.boolean(),
  value: z.array(z.object({ fundingAt: z.string(), rate: z.string().regex(/^-?\d+(\.\d+)?$/) })),
});

export interface FundingRow {
  /** Epoch ms the interval settled. */
  t: number;
  /** The signed rate per interval, a decimal string (0.0000125 is 0.00125%). */
  rate: string;
}

export interface FundingFeed {
  /** The venue's perpetual the rates are for. */
  perpetual: string;
  intervalSeconds: number | null;
  /** From a TEST venue: every figure is labelled TEST. */
  test: boolean;
  rows: FundingRow[];
}

export function fundingSource(env: DataEnv, base: string, since: string): Source<FundingFeed> {
  const raw = env.poller.source<z.infer<typeof fundingSchema>>(
    `studies-funding:${base}:${since}`,
    (signal) => env.api.rest('/venue/funding-history', fundingSchema, { query: { base, since }, signal }),
    { intervalMs: FUNDING_POLL_MS },
  );
  return combine([raw], ([snap]): Loadable<FundingFeed> => {
    if (snap.status !== 'ready') return snap as Loadable<never>;
    const rows = snap.data.value.map((row) => ({ t: Date.parse(row.fundingAt), rate: row.rate })).filter((row) => Number.isFinite(row.t));
    rows.sort((a, b) => a.t - b.t);
    return {
      status: 'ready',
      asOf: snap.asOf,
      data: { perpetual: snap.data.symbol, intervalSeconds: snap.data.intervalSeconds, test: snap.data.test, rows },
    };
  });
}

/** The venue's funding on the chart's base asset, polled from a fixed start. Mount it only while a study reads it. */
export function useFunding(base: string): Loadable<FundingFeed> {
  const env = useDataEnv();
  // The start is fixed when the feed mounts (to the hour), so the poll keeps one key.
  const since = useMemo(() => new Date(Math.floor((Date.now() - FUNDING_LOOKBACK_MS) / 3_600_000) * 3_600_000).toISOString(), []);
  return useSource(useMemo(() => fundingSource(env, base, since), [env, base, since]));
}
