/**
 * The desk's reads, all through the tab's one scheduler (`data/poll.ts`): identical requests are shared, polling
 * pauses while the tab is hidden, and the whole tab stays inside the request budget. Cadence (UI-SPEC 4.2):
 * book 2 s, trades 3 s (only while that tab shows), ticker 5 s, candles 10 s, open orders 10 s, balances 15 s, order history 15 s
 * (only while that tab shows), fills 60 s (15 s while Trade history shows or just after an order). Measured in desk.pw.mjs.
 *
 * The WebSocket the old desk tries (`useLinkedBook`) answers 503 on the local stack, so the desk polls.
 * Orders are never read or written from here; `OrderForm` owns that path.
 */
import { useMemo } from 'react';
import { z } from 'zod';
import { balancesFetcher } from '../../../data/fetchers';
import { useDataEnv, useSource } from '../../../data/hooks';
import type { DataEnv } from '../../../data/queries';
import { constantSource, type Source } from '../../../data/source';
import type { Fetcher } from '../../../data/poll';
import type { BalanceEntry } from '../../../data/derive';
import type { Loadable } from '../../../data/types';
import { useSession } from '../../../features/session/session';
import { createTradeApi, type Order, type TradeApi } from '../../../features/trade/trade-api';
import { decimalSchema } from '../../../shared/money';
import type { OrderBook, Trade } from '@intafaced/exchange-contract/schemas';
import { deskListingSchema, toDeskMarkets, type DeskMarket } from './market';

export const DESK_INTERVALS = {
  markets: 300_000,
  book: 2_000,
  tape: 3_000,
  ticker: 5_000,
  panelTickers: 10_000,
  openOrders: 10_000,
  balances: 15_000,
  lists: 15_000,
  /** Fills feed the chart's B/S markers all the time, slowly; quickly while Trade history is open or an order was just sent. */
  fillsSlow: 60_000,
  fillsFast: 15_000,
  /** The listed fee rates change rarely. */
  fees: 300_000,
} as const;

const SIGNED_OUT: Loadable<never> = { status: 'refused', code: 'auth.required' };
const OFF: Loadable<never> = { status: 'empty' };

/** The existing trade client (preview, place, cancel, reconcile, reads) bound to the session. */
export function useDeskApi(): TradeApi {
  const { api } = useSession();
  return useMemo(() => createTradeApi(api), [api]);
}

/** Every real spot market with its rules. Polled slowly: rules rarely change. */
export function useDeskMarkets(): Loadable<DeskMarket[]> {
  const env = useDataEnv();
  const source = useMemo(
    () =>
      env.poller.source<DeskMarket[]>(
        'desk-markets',
        async (signal) => {
          const result = await env.api.rest('/markets', z.array(deskListingSchema), { query: { limit: 500 }, signal });
          return result.ok ? { ok: true, data: toDeskMarkets(result.data) } : result;
        },
        { intervalMs: DESK_INTERVALS.markets },
      ),
    [env],
  );
  return useSource(source);
}

export function useBook(symbol: string): Loadable<OrderBook> {
  const env = useDataEnv();
  const api = useDeskApi();
  return useSource(
    useMemo(
      () => env.poller.source<OrderBook>(`desk-book:${symbol}`, (signal) => api.book(symbol, signal), { intervalMs: DESK_INTERVALS.book }),
      [env, api, symbol],
    ),
  );
}

/** Public trades. `enabled` false (the tab is not showing) stops the polling entirely. */
export function useTape(symbol: string, enabled: boolean): Loadable<Trade[]> {
  const env = useDataEnv();
  const api = useDeskApi();
  return useSource(
    useMemo(
      () =>
        enabled
          ? env.poller.source<Trade[]>(`desk-tape:${symbol}`, (signal) => api.tape(symbol, signal), { intervalMs: DESK_INTERVALS.tape })
          : constantSource<Trade[]>(OFF),
      [env, api, symbol, enabled],
    ),
  );
}

/** Private reads need a signed-in user and are keyed by that user so one person's rows can never show for another. */
function privateSource<T>(env: DataEnv, key: string, fetcher: Fetcher<T>, intervalMs: number, enabled = true): Source<T> {
  if (!env.userId) return constantSource<T>(SIGNED_OUT);
  if (!enabled) return constantSource<T>(OFF);
  return env.poller.source<T>(`${key}:${env.userId}`, fetcher, { intervalMs });
}

export function useBalances(): Loadable<Record<string, BalanceEntry>> {
  const env = useDataEnv();
  return useSource(
    useMemo(
      () =>
        env.userId
          ? env.poller.source(`balance:${env.userId}`, balancesFetcher(env.api), { intervalMs: DESK_INTERVALS.balances })
          : constantSource<Record<string, BalanceEntry>>(SIGNED_OUT),
      [env],
    ),
  );
}

export function useOpenOrders(enabled = true): Loadable<Order[]> {
  const env = useDataEnv();
  const api = useDeskApi();
  return useSource(
    useMemo(
      () =>
        privateSource<Order[]>(
          env,
          'desk-open',
          (signal) => api.orders('open', undefined, 100, signal),
          DESK_INTERVALS.openOrders,
          enabled,
        ),
      [env, api, enabled],
    ),
  );
}

export function useClosedOrders(enabled: boolean): Loadable<Order[]> {
  const env = useDataEnv();
  const api = useDeskApi();
  return useSource(
    useMemo(
      () =>
        privateSource<Order[]>(env, 'desk-closed', (signal) => api.orders('closed', undefined, 100, signal), DESK_INTERVALS.lists, enabled),
      [env, api, enabled],
    ),
  );
}

export function useFills(fast: boolean): Loadable<Trade[]> {
  const env = useDataEnv();
  const api = useDeskApi();
  return useSource(
    useMemo(
      () =>
        privateSource<Trade[]>(
          env,
          'desk-fills',
          (signal) => api.fills(undefined, 100, signal),
          fast ? DESK_INTERVALS.fillsFast : DESK_INTERVALS.fillsSlow,
        ),
      [env, api, fast],
    ),
  );
}

const feesSchema = z.record(z.string(), z.object({ maker: decimalSchema, taker: decimalSchema }).passthrough());
export type MyFees = Record<string, { maker: string; taker: string }>;

/** The caller's own fee rates for each pair (maker and taker, as ratios), at its fee tier and after its rank discount; the order check has the rate this order pays. */
export function useMyFees(): Loadable<MyFees> {
  const env = useDataEnv();
  return useSource(
    useMemo(
      () =>
        privateSource<MyFees>(
          env,
          'desk-fees',
          async (signal) => {
            const result = await env.api.rest('/account/fees', feesSchema, { signal });
            return result.ok
              ? {
                  ok: true,
                  data: Object.fromEntries(
                    Object.entries(result.data).map(([symbol, row]) => [symbol, { maker: row.maker, taker: row.taker }]),
                  ),
                }
              : result;
          },
          DESK_INTERVALS.fees,
        ),
      [env],
    ),
  );
}

/** Ask the scheduler to fetch the private lists now (after an order is placed or cancelled). */
export function useRefreshPrivate(): () => void {
  const env = useDataEnv();
  return () => {
    if (!env.userId) return;
    for (const key of ['desk-open', 'desk-closed', 'desk-fills', 'balance']) env.poller.refresh(`${key}:${env.userId}`);
  };
}
