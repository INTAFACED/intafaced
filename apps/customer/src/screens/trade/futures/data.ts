/**
 * The Futures and Margin rooms' reads, all through the tab's one scheduler (`data/poll.ts`): identical requests are shared,
 * polling pauses while the tab is hidden, and the tab stays inside the request budget. Private reads are keyed by the
 * signed-in user so one person's rows can never show for another.
 *
 * Cadence (TRFUT-SPEC §4): mark strip 5 s, positions 5 s, funding 60 s, margin calls 30 s, ADL 60 s, history 30 s, markets 5 min.
 * Writes are not here: they run through `useFuturesWrite` (write.ts) under the shared device guard.
 */
import { useMemo } from 'react';
import { useDataEnv, useSource } from '../../../data/hooks';
import type { DataEnv } from '../../../data/queries';
import type { Fetcher } from '../../../data/poll';
import { constantSource, type Source } from '../../../data/source';
import type { Loadable } from '../../../data/types';
import { useSession } from '../../../features/session/session';
import type { Position } from '@intafaced/exchange-contract/schemas';
import {
  createFuturesApi,
  isFuturesListing,
  type AdlDisclosure,
  type AdlEvent,
  type Collateral,
  type ConditionalOrder,
  type EntryProtection,
  type FundingRate,
  type FuturesApi,
  type FuturesListing,
  type FuturesOrder,
  type GatedList,
  type MarginCall,
  type OrderTypeCatalogue,
  type RiskTiers,
  type TickerStrip,
} from './api';
import { isLive } from './model';

export const FUTURES_INTERVALS = {
  markets: 300_000,
  strip: 5_000,
  positions: 5_000,
  funding: 60_000,
  marginCalls: 30_000,
  adl: 60_000,
  history: 30_000,
  orders: 5_000,
  /** Take profit, stop loss and stops: a fired one is followed from armed to filled, so it is read as often as orders. */
  conditional: 5_000,
  orderTypes: 300_000,
  access: 60_000,
  tiers: 60_000,
  collateral: 30_000,
} as const;

/** How old a read may be before the room calls it stale and disables actions that need a fresh mark. */
export const STALE_AFTER_MS = { strip: 15_000, positions: 15_000, funding: 120_000 } as const;

/** Most margin-call reads one poll makes. A trader with more live positions sees the first ones and a note. */
export const MARGIN_CALL_CAP = 20;

const SIGNED_OUT: Loadable<never> = { status: 'refused', code: 'auth.required' };
const OFF: Loadable<never> = { status: 'empty' };

export function useFuturesApi(): FuturesApi {
  const { api } = useSession();
  return useMemo(() => createFuturesApi(api), [api]);
}

function privateSource<T>(env: DataEnv, key: string, fetcher: Fetcher<T>, intervalMs: number, enabled = true): Source<T> {
  if (!env.userId) return constantSource<T>(SIGNED_OUT);
  if (!enabled) return constantSource<T>(OFF);
  return env.poller.source<T>(`${key}:${env.userId}`, fetcher, { intervalMs });
}

/** Every real futures contract. An empty list is a real answer (the local stack lists none): the room says so. */
export function useFuturesMarkets(): Loadable<FuturesListing[]> {
  const env = useDataEnv();
  const api = useFuturesApi();
  return useSource(
    useMemo(
      () =>
        env.poller.source<FuturesListing[]>(
          'futures-markets',
          async (signal) => {
            const result = await api.markets(signal);
            return result.ok ? { ok: true, data: result.data.filter(isFuturesListing) } : result;
          },
          { intervalMs: FUTURES_INTERVALS.markets },
        ),
      [env, api],
    ),
  );
}

export function useTickerStrip(symbol: string | null): Loadable<TickerStrip> {
  const env = useDataEnv();
  const api = useFuturesApi();
  return useSource(
    useMemo(
      () =>
        symbol
          ? env.poller.source<TickerStrip>(`futures-strip:${symbol}`, (signal) => api.ticker(symbol, signal), {
              intervalMs: FUTURES_INTERVALS.strip,
            })
          : constantSource<TickerStrip>(OFF),
      [env, api, symbol],
    ),
  );
}

export function useFundingRate(symbol: string | null): Loadable<FundingRate> {
  const env = useDataEnv();
  const api = useFuturesApi();
  return useSource(
    useMemo(
      () =>
        symbol
          ? env.poller.source<FundingRate>(`futures-funding:${symbol}`, (signal) => api.fundingRate(symbol, signal), {
              intervalMs: FUTURES_INTERVALS.funding,
            })
          : constantSource<FundingRate>(OFF),
      [env, api, symbol],
    ),
  );
}

/** What counts as margin for the account, read while the Collateral tab is open. Private: keyed by the signed-in user. */
export function useCollateral(enabled: boolean): Loadable<Collateral> {
  const env = useDataEnv();
  const api = useFuturesApi();
  return useSource(
    useMemo(
      () => privateSource<Collateral>(env, 'futures-collateral', (signal) => api.collateral(signal), FUTURES_INTERVALS.collateral, enabled),
      [env, api, enabled],
    ),
  );
}

/** The maintenance tiers for one contract, read while the Margin tiers tab is open (the depth moves, so it polls). */
export function useRiskTiers(symbol: string | null, enabled: boolean): Loadable<RiskTiers> {
  const env = useDataEnv();
  const api = useFuturesApi();
  return useSource(
    useMemo(
      () =>
        symbol && enabled
          ? env.poller.source<RiskTiers>(`futures-tiers:${symbol}`, (signal) => api.tiers(symbol, signal), {
              intervalMs: FUTURES_INTERVALS.tiers,
            })
          : constantSource<RiskTiers>(OFF),
      [env, api, symbol, enabled],
    ),
  );
}

/** Open and closing positions. `reload` on the loadable's `retry` is the manual refresh. */
export function useOpenPositions(): Loadable<Position[]> {
  const env = useDataEnv();
  const api = useFuturesApi();
  return useSource(
    useMemo(
      () => privateSource<Position[]>(env, 'futures-positions', (signal) => api.positions(signal), FUTURES_INTERVALS.positions),
      [env, api],
    ),
  );
}

/** Closed and liquidated positions. Polls only while the History tab shows. */
export function useClosedPositions(enabled: boolean): Loadable<Position[]> {
  const env = useDataEnv();
  const api = useFuturesApi();
  return useSource(
    useMemo(
      () => privateSource<Position[]>(env, 'futures-closed', (signal) => api.closed(signal), FUTURES_INTERVALS.history, enabled),
      [env, api, enabled],
    ),
  );
}

export function useAdlDisclosure(): Loadable<AdlDisclosure> {
  const env = useDataEnv();
  const api = useFuturesApi();
  return useSource(
    useMemo(
      () => privateSource<AdlDisclosure>(env, 'futures-adl', (signal) => api.adlDisclosure(signal), FUTURES_INTERVALS.adl),
      [env, api],
    ),
  );
}

export function useAdlEvents(enabled: boolean): Loadable<AdlEvent[]> {
  const env = useDataEnv();
  const api = useFuturesApi();
  return useSource(
    useMemo(
      () => privateSource<AdlEvent[]>(env, 'futures-adl-events', (signal) => api.adlEvents(signal), FUTURES_INTERVALS.adl, enabled),
      [env, api, enabled],
    ),
  );
}

export type MarginCalls = Record<string, MarginCall | null>;

/**
 * Delivered margin calls for live positions, by position id. `null` means the service answered "no delivered call"
 * (a 404 by design); a position missing from the map was not asked about (past the cap). Any other failure fails the read.
 */
export function useMarginCalls(positions: readonly Position[], enabled: boolean): Loadable<MarginCalls> {
  const env = useDataEnv();
  const api = useFuturesApi();
  const ids = positions
    .filter(isLive)
    .map((p) => p.id)
    .filter((id): id is string => id !== null)
    .slice(0, MARGIN_CALL_CAP);
  const key = ids.join(',');
  return useSource(
    useMemo(
      () =>
        privateSource<MarginCalls>(
          env,
          `futures-margin-calls:${key}`,
          async (signal) => {
            const out: MarginCalls = {};
            for (const id of key ? key.split(',') : []) {
              const result = await api.marginCall(id, signal);
              if (result.ok) out[id] = result.data;
              else if (result.code === 'trade.margin_call_not_found') out[id] = null;
              else return result;
            }
            return { ok: true, data: out };
          },
          FUTURES_INTERVALS.marginCalls,
          enabled,
        ),
      [env, api, key, enabled],
    ),
  );
}

/** What the futures book offers, per contract (public). */
export function useOrderTypes(): Loadable<OrderTypeCatalogue> {
  const env = useDataEnv();
  const api = useFuturesApi();
  return useSource(
    useMemo(
      () =>
        env.poller.source<OrderTypeCatalogue>('futures-order-types', (signal) => api.orderTypes(signal), {
          intervalMs: FUTURES_INTERVALS.orderTypes,
        }),
      [env, api],
    ),
  );
}

/** The trader's futures orders through the book: resting ones, or all recent ones. */
export function useFuturesOrders(scope: 'open' | 'all', enabled: boolean): Loadable<FuturesOrder[]> {
  const env = useDataEnv();
  const api = useFuturesApi();
  return useSource(
    useMemo(
      () =>
        privateSource<FuturesOrder[]>(
          env,
          `futures-orders-${scope}`,
          (signal) => api.orders(scope, signal),
          FUTURES_INTERVALS.orders,
          enabled,
        ),
      [env, api, scope, enabled],
    ),
  );
}

/** The trader's take-profit, stop-loss and stop orders, armed and recent, with what each did when it fired. */
/** The take profits and stop losses attached to opening orders, read as often as the conditional orders. */
export function useEntryProtections(enabled: boolean): Loadable<EntryProtection[]> {
  const env = useDataEnv();
  const api = useFuturesApi();
  return useSource(
    useMemo(
      () =>
        privateSource<EntryProtection[]>(
          env,
          'futures-entry-protection',
          (signal) => api.entryProtections(signal),
          FUTURES_INTERVALS.conditional,
          enabled,
        ),
      [env, api, enabled],
    ),
  );
}

export function useConditionalOrders(enabled: boolean): Loadable<ConditionalOrder[]> {
  const env = useDataEnv();
  const api = useFuturesApi();
  return useSource(
    useMemo(
      () =>
        privateSource<ConditionalOrder[]>(
          env,
          'futures-conditional',
          (signal) => api.conditionalOrders(signal),
          FUTURES_INTERVALS.conditional,
          enabled,
        ),
      [env, api, enabled],
    ),
  );
}

/** Each contract open or blocked for this account, with every reason (D-ops-01). */
export function useGatedList(): Loadable<GatedList> {
  const env = useDataEnv();
  const api = useFuturesApi();
  return useSource(
    useMemo(() => privateSource<GatedList>(env, 'futures-gated', (signal) => api.gatedList(signal), FUTURES_INTERVALS.access), [env, api]),
  );
}

/** Re-read now, after a write or when the trader presses refresh. Only keys with a mounted reader fetch. */
export function useFuturesRefresh(): () => void {
  const env = useDataEnv();
  return useMemo(
    () => () => {
      if (!env.userId) return;
      for (const key of [
        'futures-positions',
        'futures-closed',
        'futures-adl',
        'futures-adl-events',
        'futures-orders-open',
        'futures-orders-all',
        'futures-conditional',
        'futures-entry-protection',
        'futures-gated',
        'balance',
      ])
        env.poller.refresh(`${key}:${env.userId}`);
    },
    [env],
  );
}
