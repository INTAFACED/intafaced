/**
 * Candles for the desk chart: any interval the service offers, one polled call, quiet intervals forward-filled
 * from the previous close (UI-SPEC 4.2) so the line never jumps over a silent hour. Weekly candles are shown as
 * the service sends them: a week's start is not a multiple of the epoch week, so filling would shift them.
 */
import { useMemo } from 'react';
import { z } from 'zod';
import { ohlcvSchema, TIMEFRAME_MS } from '@intafaced/exchange-contract/schemas';
import { venueChartCandlesReadSchema, type VenueCandle } from '@intafaced/contracts/trade-venue-door';
import { forwardFill, type OhlcvRow } from '../../../data/derive';
import { useDataEnv, useSource } from '../../../data/hooks';
import type { DataEnv } from '../../../data/queries';
import { combine, type Source } from '../../../data/source';
import type { Candle, Loadable } from '../../../data/types';
import { useChartSource } from './chart-source';

export const CHART_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export const MORE_INTERVALS = ['3m', '30m', '2h', '6h', '12h', '1w'] as const;
export type ChartInterval = (typeof CHART_INTERVALS)[number] | (typeof MORE_INTERVALS)[number];

export const CANDLE_POLL_MS = 10_000;

export function venueRowsOf(rows: readonly VenueCandle[]): OhlcvRow[] {
  return rows.map((c) => [Date.parse(c.openAt), c.openPrice, c.highPrice, c.lowPrice, c.closePrice, c.baseVolume]);
}

function barsFromRows(rows: readonly OhlcvRow[], interval: ChartInterval, nowMs: number, limit: number): Candle[] {
  const stepMs = TIMEFRAME_MS[interval];
  return interval === '1w'
    ? rows.map((row): Candle => ({ t: row[0], o: row[1], h: row[2], l: row[3], c: row[4], v: row[5], filled: false })).slice(-limit)
    : forwardFill(rows, { stepMs, nowMs, fromMs: Math.floor(nowMs / stepMs) * stepMs - (limit - 1) * stepMs }).slice(-limit);
}

export function candleSource(env: DataEnv, symbol: string, interval: ChartInterval, limit: number): Source<Candle[]> {
  const raw = env.poller.source<OhlcvRow[]>(
    `desk-candles:${symbol}:${interval}:${limit}`,
    (signal) =>
      env.api.rest(`/ohlcv/${encodeURIComponent(symbol)}`, z.array(ohlcvSchema), {
        query: { timeframe: interval, limit },
        signal,
      }) as Promise<{ ok: true; data: OhlcvRow[] } | { ok: false; reason: string; code?: string; status?: number }>,
    { intervalMs: CANDLE_POLL_MS },
  );
  return combine([raw], ([snap]): Loadable<Candle[]> => {
    if (snap.status !== 'ready') return snap as Loadable<never>;
    const nowMs = (env.now ?? Date.now)();
    const candles = barsFromRows(snap.data, interval, nowMs, limit);
    return candles.length === 0 ? { status: 'empty' } : { status: 'ready', data: candles, asOf: snap.asOf };
  });
}

function venueCandleSource(env: DataEnv, symbol: string, interval: ChartInterval, limit: number): Source<Candle[]> {
  const raw = env.poller.source(
    `venue-chart-candles:${symbol}:${interval}:${limit}`,
    (signal) =>
      env.api.rest('/venue/chart-candles', venueChartCandlesReadSchema, {
        query: { symbol, interval, limit },
        signal,
      }),
    { intervalMs: CANDLE_POLL_MS },
  );
  return combine([raw], ([snap]): Loadable<Candle[]> => {
    if (snap.status !== 'ready') return snap as Loadable<never>;
    const parsedAsOf = Date.parse(snap.data.asOf);
    const nowMs = Number.isFinite(parsedAsOf) ? parsedAsOf : (env.now ?? Date.now)();
    const candles = barsFromRows(venueRowsOf(snap.data.value), interval, nowMs, limit);
    return candles.length === 0 ? { status: 'empty' } : { status: 'ready', data: candles, asOf: snap.asOf };
  });
}

export function useChartCandles(symbol: string, interval: ChartInterval, limit = 240): Loadable<Candle[]> {
  const env = useDataEnv();
  const source = useChartSource();
  const isVenue = source.kind === 'venue';
  return useSource(
    useMemo(
      () => (isVenue ? venueCandleSource(env, symbol, interval, limit) : candleSource(env, symbol, interval, limit)),
      [env, isVenue, symbol, interval, limit],
    ),
  );
}
