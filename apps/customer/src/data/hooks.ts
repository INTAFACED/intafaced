/**
 * The hooks screens use (UI-SPEC §4.2). Thin React layer over `queries.ts`:
 * each hook builds its source once per client/arguments and reads it with
 * `useSyncExternalStore`. Polling starts with the first mounted reader and stops
 * with the last; identical requests are shared across components.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { useSession } from '../features/session/session';
import { defaultPoller } from './poll';
import {
  candlesSource,
  marketsSource,
  moversSource,
  portfolioSource,
  sparklinesSource,
  tickersSource,
  tickerSource,
  type DataEnv,
  type IntervalOption,
} from './queries';
import type { Source } from './source';
import type { Candle, Decimal, Loadable, MarketRow, Movers, PortfolioSummary, TickerRow, Timeframe } from './types';

/** Read any source as a `Loadable`. */
export function useSource<T>(source: Source<T>): Loadable<T> {
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}

/** The client, the signed-in user and the tab's scheduler, stable until the session changes. */
export function useDataEnv(): DataEnv {
  const { api, userId } = useSession();
  return useMemo(() => ({ poller: defaultPoller(), api, userId }), [api, userId]);
}

/** Orderable, OPEN spot markets by default; `includeClosed` adds the rest. */
export function useMarkets(options: { includeClosed?: boolean } = {}): Loadable<MarketRow[]> {
  const env = useDataEnv();
  const includeClosed = options.includeClosed ?? false;
  return useSource(useMemo(() => marketsSource(env, { includeClosed }), [env, includeClosed]));
}

/** Every ticker in one polled call (10 s by default). */
export function useTickers(options: IntervalOption = {}): Loadable<Record<string, TickerRow>> {
  const env = useDataEnv();
  const intervalMs = options.intervalMs;
  return useSource(useMemo(() => tickersSource(env, { intervalMs }), [env, intervalMs]));
}

/** One market's ticker (5 s by default). */
export function useTicker(symbol: string, options: IntervalOption = {}): Loadable<TickerRow> {
  const env = useDataEnv();
  const intervalMs = options.intervalMs;
  return useSource(useMemo(() => tickerSource(env, symbol, { intervalMs }), [env, symbol, intervalMs]));
}

/** Forward-filled candles: one per interval, quiet ones flat at the previous close. */
export function useCandles(symbol: string, timeframe: Timeframe, limit: number, options: IntervalOption = {}): Loadable<Candle[]> {
  const env = useDataEnv();
  const intervalMs = options.intervalMs;
  return useSource(
    useMemo(() => candlesSource(env, symbol, timeframe, limit, { intervalMs }), [env, symbol, timeframe, limit, intervalMs]),
  );
}

/** Up to 24 hourly closes per symbol. A symbol with no history is simply absent from the record. */
export function useSparklines(symbols: readonly string[]): Loadable<Record<string, Decimal[]>> {
  const env = useDataEnv();
  const key = [...new Set(symbols)].join(',');
  return useSource(useMemo(() => sparklinesSource(env, key ? key.split(',') : []), [env, key]));
}

/** Biggest 24 h gainers and losers, one row per coin. */
export function useMovers(limit: number): Loadable<Movers> {
  const env = useDataEnv();
  return useSource(useMemo(() => moversSource(env, limit), [env, limit]));
}

/** Est. total value in USD, today's change, Cash/Crypto split and per-coin rows. */
export function usePortfolio(): Loadable<PortfolioSummary> {
  const env = useDataEnv();
  return useSource(useMemo(() => portfolioSource(env), [env]));
}
