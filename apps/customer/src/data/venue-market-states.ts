import { useMemo } from 'react';
import {
  venueMarketStatesSchema,
  venueTickersReadSchema,
  type VenueMarketState,
  type VenueMarketStates,
  type VenueTickerRow,
  type VenueTickersRead,
} from '@intafaced/contracts/trade-venue-door';
import { maintenanceOf, type MaintenanceWindowSoon } from '../shared/market-maintenance';
import { useDataEnv, useSource } from './hooks';
import type { Fetcher } from './poll';
import type { ListingState, Loadable, MarketRow, TickerRow } from './types';

export type { VenueMarketState, VenueMarketStates, VenueTickersRead };

/**
 * The venue's own market states (J-cex-spot-14 #1 #2 #5 #6 #7): svc-trade's public `GET /api/v1/venue/market-states`,
 * each market we show with the venue's trading state, session, opening window, zone, our listing and upcoming
 * maintenance beside them. Where the deployment's venue door is off the read refuses `trade.user_venue_off`, and the
 * screens keep reading what they read today.
 */
export const VENUE_DOOR_OFF = 'trade.user_venue_off';

/** Re-read every 30 seconds, as /status re-reads its other parts. */
const INTERVAL_MS = 30_000;

export function useVenueMarketStates(): Loadable<VenueMarketStates> {
  const env = useDataEnv();
  return useSource(
    useMemo(() => {
      const fetcher: Fetcher<VenueMarketStates> = (signal) => env.api.rest('/venue/market-states', venueMarketStatesSchema, { signal });
      return env.poller.source('venue-market-states', fetcher, { intervalMs: INTERVAL_MS });
    }, [env]),
  );
}

/**
 * The venue's own prices on each spot market it lists (J-cex-spot-14 #8): svc-trade's public `GET /api/v1/venue/tickers`,
 * the last print, best bid and ask and the 24h range and volume from the venue's own book and tape. Re-read on the same
 * 30 seconds as the market states.
 */
export function useVenueTickers(): Loadable<VenueTickersRead> {
  const env = useDataEnv();
  return useSource(
    useMemo(() => {
      const fetcher: Fetcher<VenueTickersRead> = (signal) => env.api.rest('/venue/tickers', venueTickersReadSchema, { signal });
      return env.poller.source('venue-tickers', fetcher, { intervalMs: INTERVAL_MS });
    }, [env]),
  );
}

/**
 * A venue ticker as a markets-list price row: what the venue publishes, and null (never zero) for what it does not. A
 * perpetual has no last print here: its price is the venue's mark, and its 24h move is from the venue's own price 24
 * hours ago.
 */
export function venueTickerRow(t: VenueTickerRow): TickerRow {
  return {
    symbol: t.symbol,
    last: t.last ?? t.mark ?? null,
    bid: t.bid,
    ask: t.ask,
    open24h: t.open ?? null,
    high24h: t.high,
    low24h: t.low,
    change24h: t.change ?? null,
    changePct24h: t.changePct ?? null,
    baseVolume24h: t.baseVolume,
    quoteVolume24h: t.quoteVolume,
    windowStart: null,
    source: 'server',
  };
}

/** True when the read says the venue door is off here: the own-engine reads stand. */
export const venueDoorOff = (load: Loadable<unknown>): boolean => load.status === 'refused' && load.code === VENUE_DOOR_OFF;

/** A trading mode /status has words for: the one that decides what a new order on this market meets now. */
export type VenueModeKey = 'OPEN' | 'PRELAUNCH' | 'LIMIT_ONLY' | 'HALTED' | 'CANCEL_ONLY' | 'REDUCE_ONLY' | 'DELISTING';

/**
 * A market's trading mode now, from the venue's own state and our listing, the stricter first: our stop, delisting or
 * opening time refuses a new order whatever the venue says; then the venue's own state or closed session; then our
 * close-only routing. `null` when the venue reports no state for it: never assumed open.
 */
export function venueModeOf(m: VenueMarketState): VenueModeKey | null {
  if (m.listing.delisted || m.status === 'delisted') return 'DELISTING';
  if (m.listing.routing === 'stop') return 'HALTED';
  if (!m.listing.open) return 'PRELAUNCH';
  if (m.status === null) return null;
  if (m.status === 'halted') return 'HALTED';
  if (m.status === 'cancel_only') return 'CANCEL_ONLY';
  if (m.session.known && m.session.value.state === 'closed') return 'HALTED';
  if (m.status === 'limit_only') return 'LIMIT_ONLY';
  if (m.listing.routing === 'close_only') return 'REDUCE_ONLY';
  return 'OPEN';
}

/** The listing state the markets list names on a row: open, upcoming, delisting (dated), delisted, or paused (halted). */
export function venueListingOf(m: VenueMarketState): ListingState {
  if (!m.listing.open) return 'upcoming';
  if (m.listing.delisted || m.status === 'delisted') return 'delisted';
  if (m.listing.delistsAt !== null) return 'delisting';
  return venueModeOf(m) === 'OPEN' ? 'open' : 'halted';
}

/** A venue spot market as a row of the markets list: tradeable only when it is open, with no delisting set, in mode OPEN. */
export function venueMarketRow(m: VenueMarketState): MarketRow {
  const listing = venueListingOf(m);
  return {
    symbol: m.symbol,
    base: m.baseAsset,
    quote: m.quoteAsset,
    orderable: listing === 'open',
    tickSize: m.tickSize,
    lotSize: m.lotSize,
    minAmount: null,
    listedAt: m.listing.opensAt,
    listing,
    delistsAt: m.listing.delistsAt,
  };
}

/** Session and maintenance status per venue market for MarketsList (J-cex-spot-14 #5 #6). */
export function venueListingStatuses(states: VenueMarketStates): Readonly<
  Record<
    string,
    {
      separateFromSpot: boolean;
      sessionOpen: boolean | null;
      opensAt: number | null;
      maintenance: MaintenanceWindowSoon | null;
    }
  >
> {
  const out: Record<
    string,
    { separateFromSpot: boolean; sessionOpen: boolean | null; opensAt: number | null; maintenance: MaintenanceWindowSoon | null }
  > = {};
  for (const m of states.value.markets) {
    const sess = m.session.known ? m.session.value : null;
    const shut = sess?.state === 'closed';
    const reopens = shut && sess?.reopensAt ? Date.parse(sess.reopensAt) : Number.NaN;
    out[m.symbol] = {
      separateFromSpot: false,
      sessionOpen: sess ? !shut : null,
      opensAt: Number.isNaN(reopens) ? null : reopens,
      maintenance: maintenanceOf(m.upcomingMaintenance),
    };
  }
  return out;
}
