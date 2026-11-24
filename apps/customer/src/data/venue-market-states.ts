import { useMemo } from 'react';
import { venueMarketStatesSchema, type VenueMarketState, type VenueMarketStates } from '@intafaced/contracts/trade-venue-door';
import { useDataEnv, useSource } from './hooks';
import type { Fetcher } from './poll';
import type { ListingState, Loadable, MarketRow } from './types';

export type { VenueMarketState, VenueMarketStates };

/**
 * The venue's own market states (J-cex-spot-14 #1 #2): svc-trade's public `GET /api/v1/venue/market-states`, each market
 * we show with the venue's trading state and session and our listing beside them. Where the deployment's venue door is
 * off the read refuses `trade.user_venue_off`, and the screens keep reading what they read today.
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

/** True when the read says the venue door is off here: the own-engine reads stand. */
export const venueDoorOff = (load: Loadable<unknown>): boolean => load.status === 'refused' && load.code === VENUE_DOOR_OFF;

/** A trading mode /status has words for: the one that decides what a new order on this market meets now. */
export type VenueModeKey = 'OPEN' | 'PRELAUNCH' | 'HALTED' | 'CANCEL_ONLY' | 'REDUCE_ONLY' | 'DELISTING';

/**
 * A market's trading mode now, from the venue's own state and our listing, the stricter first: our stop, delisting or
 * opening time refuses a new order whatever the venue says; then the venue's own state; then our close-only routing.
 * `null` when the venue reports no state for it: never assumed open.
 */
export function venueModeOf(m: VenueMarketState): VenueModeKey | null {
  if (m.listing.delisted || m.status === 'delisted') return 'DELISTING';
  if (m.listing.routing === 'stop') return 'HALTED';
  if (!m.listing.open) return 'PRELAUNCH';
  if (m.status === null) return null;
  if (m.status === 'halted') return 'HALTED';
  if (m.status === 'cancel_only') return 'CANCEL_ONLY';
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
