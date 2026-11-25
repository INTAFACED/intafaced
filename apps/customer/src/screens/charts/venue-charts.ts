/**
 * Public venue chart markets for `/charts/:symbol` (J-charts-desk-01): reads `GET /api/v1/venue/chart-markets` through
 * the tab's shared poller, signed in or signed out. When the user-venue door is off (`404 trade.user_venue_off`),
 * answers `{ status: 'off' }` so the workbench keeps today's engine read; any other failure stays an error and never
 * silently falls back to our own book.
 */
import { useMemo } from 'react';
import { venueChartMarketsReadSchema, type VenueChartMarket, type VenueChartMarketsRead } from '@intafaced/contracts/trade-venue-door';
import { useDataEnv, useSource } from '../../data/hooks';
import type { Candle, Loadable } from '../../data/types';
import type { DeskMarket } from '../trade/desk/market';
import type { ChartSource } from '../trade/chart/chart-source';
import { TEST_EVIDENCE_PREFIX, type BookHaltView, type LifecycleView } from './data-status';

const VENUE_MARKETS_POLL_MS = 60_000;

export type VenueChartMode = Extract<ChartSource, { kind: 'venue' }> & {
  readonly deskMarkets: DeskMarket[];
};

export type VenueMarketsRead =
  | { readonly status: 'loading' }
  | { readonly status: 'off' }
  | { readonly status: 'error'; readonly retry: () => void }
  | { readonly status: 'ready'; readonly data: VenueChartMode };

type ProbeResult = { readonly kind: 'off' } | { readonly kind: 'venue'; readonly read: VenueChartMarketsRead };

/** The chart lifecycle state word for one venue market, combining our listing routing and the venue's own status. */
export function venueLifecycleState(market: VenueChartMarket | undefined): string | null {
  if (!market) return null;
  if (market.listing?.delisted || market.status === 'delisted') return 'DELISTED';
  if (market.status === 'halted' || market.listing?.routing === 'stop') return 'HALTED';
  if (market.status === 'cancel_only') return 'CANCEL_ONLY';
  if (market.listing?.routing === 'close_only') return 'REDUCE_ONLY';
  return 'OPEN';
}

export function toVenueDeskMarket(market: VenueChartMarket): DeskMarket {
  const state = venueLifecycleState(market);
  return {
    symbol: market.symbol,
    base: market.baseAsset,
    quote: market.quoteAsset,
    tickSize: market.tickSize,
    lotSize: market.lotSize,
    minAmount: null,
    minCost: market.minOrderNotional ?? null,
    open: state === 'OPEN',
    state,
  };
}

export function useVenueChartMarkets(): VenueMarketsRead {
  const env = useDataEnv();
  const source = useMemo(
    () =>
      env.poller.source<ProbeResult>(
        'venue-chart-markets',
        async (signal) => {
          const result = await env.api.rest('/venue/chart-markets', venueChartMarketsReadSchema, { signal });
          if (!result.ok) {
            if (result.code === 'trade.user_venue_off') return { ok: true, data: { kind: 'off' } };
            return result;
          }
          return { ok: true, data: { kind: 'venue', read: result.data } };
        },
        { intervalMs: VENUE_MARKETS_POLL_MS },
      ),
    [env],
  );
  const snap = useSource(source);
  return useMemo<VenueMarketsRead>(() => {
    if (snap.status === 'loading') return { status: 'loading' };
    if (snap.status !== 'ready')
      return { status: 'error', retry: snap.status === 'error' ? snap.retry : () => env.poller.refresh('venue-chart-markets') };
    if (snap.data.kind === 'off') return { status: 'off' };
    const { read } = snap.data;
    const parsedAsOf = Date.parse(read.asOf);
    return {
      status: 'ready',
      data: {
        kind: 'venue',
        venueId: read.venueId,
        venueName: read.venueName,
        test: read.test,
        intervals: read.intervals,
        asOf: Number.isFinite(parsedAsOf) ? parsedAsOf : snap.asOf,
        markets: read.value,
        deskMarkets: read.value.map(toVenueDeskMarket),
      },
    };
  }, [snap, env]);
}

/**
 * Status inputs for a venue market on the chart workbench, built purely from the venue's own market status and candles
 * without calling our own engine's lifecycle, matching-halt or tape routes.
 */
export function venueStatusInputs(
  venue: Extract<ChartSource, { kind: 'venue' }>,
  symbol: string,
  candles: Loadable<Candle[]>,
  nowMs: number,
): {
  lifecycle: Loadable<LifecycleView>;
  bookHalt: Loadable<BookHaltView>;
  lastTrade: Loadable<number | null>;
} {
  const market = venue.markets.find((m) => m.symbol === symbol);
  const state = venueLifecycleState(market) ?? 'OPEN';
  const freshAsOf = candles.status === 'ready' ? candles.asOf : nowMs;
  const lifecycle: Loadable<LifecycleView> = {
    status: 'ready',
    data: {
      state,
      effectiveAt: null,
      evidenceRefs: venue.test ? [`${TEST_EVIDENCE_PREFIX}venue:${venue.venueId}`] : [],
    },
    asOf: freshAsOf,
  };
  const bookHalt: Loadable<BookHaltView> = {
    status: 'ready',
    data: {
      halted: state === 'HALTED',
      venueHalted: false,
      haltedSinceMs: null,
      venueHaltedSinceMs: null,
    },
    asOf: freshAsOf,
  };
  let lastTrade: Loadable<number | null>;
  if (candles.status === 'ready') {
    let newest: number | null = null;
    for (let i = candles.data.length - 1; i >= 0; i -= 1) {
      if (!candles.data[i]!.filled) {
        newest = candles.data[i]!.t;
        break;
      }
    }
    lastTrade = { status: 'ready', data: newest, asOf: candles.asOf };
  } else if (candles.status === 'empty') {
    lastTrade = { status: 'ready', data: null, asOf: nowMs };
  } else {
    lastTrade = candles as Loadable<never>;
  }
  return { lifecycle, bookHalt, lastTrade };
}
