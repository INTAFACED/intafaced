/**
 * Live OTC mid feed — SOCKET §13 `socket.otc-mid-feed`.
 *
 * `createConfigOtcMidSource` stamps a fixed boot map (asOf = boot). That is
 * not a live feed: after owner `maxMidAgeSeconds` the desk goes dark on purpose.
 *
 * Closing this socket: `createVenueOtcMidSource` refreshes asOf from the venue
 * snapshot's observedAt when TRADE_OTC_MID_FROM_VENUE is on and a public adapter
 * exists. Default remains OFF. Never invent mids; unmapped / dark book → null.
 */

import { logRefusalSpec } from '../refusal-spec-log.js';

export const OTC_MID_FEED_SOCKET = 'socket.otc-mid-feed' as const;

export const OTC_MID_FEED_RESIDUAL = 'A live OTC reference price is not available yet. The desk will not guess a price.';

export const OTC_MID_FEED_FLAG_ON_VENUE_UNWIRED =
  'TRADE_OTC_MID_FROM_VENUE is on but no public venue adapter is installed — refuse-closed; boot TRADE_OTC_MIDS map is not a live feed';

export const OTC_MID_FEED_FLAG_ON_SYMBOL_MAP_EMPTY =
  'TRADE_OTC_MID_FROM_VENUE is on but TRADE_OTC_VENUE_SYMBOLS is empty — refuse-closed; unmapped pairs cannot invent mids';

export type OtcMidFeedWiring = 'flag_off' | 'flag_on_venue_unwired' | 'flag_on_symbol_map_empty' | 'live_observation';

export type OtcMidFeedWiringInput = {
  readonly midFromVenue: boolean;
  readonly venueAdapterInstalled: boolean;
  readonly venueSymbolsConfigured: boolean;
  readonly liveObservationFeed: boolean;
};

export type OtcMidFeedWiringStatus = {
  readonly published: boolean;
  readonly socket: typeof OTC_MID_FEED_SOCKET;
  readonly residual: string | null;
  readonly bootMapAllowed: boolean;
  readonly liveObservationFeed: boolean;
  readonly wiring: OtcMidFeedWiring;
};

/** Honest mid-feed wiring posture for deskStatus — names flag-on-but-unwired separately. */
export function describeOtcMidFeedWiring(input: OtcMidFeedWiringInput): OtcMidFeedWiringStatus {
  if (!input.midFromVenue) {
    return { wiring: 'flag_off', ...otcMidFeedStatus(false), residual: OTC_MID_FEED_RESIDUAL };
  }
  if (!input.venueAdapterInstalled) {
    return {
      wiring: 'flag_on_venue_unwired',
      ...otcMidFeedStatus(false),
      residual: OTC_MID_FEED_FLAG_ON_VENUE_UNWIRED,
    };
  }
  if (!input.venueSymbolsConfigured) {
    return {
      wiring: 'flag_on_symbol_map_empty',
      ...otcMidFeedStatus(false),
      residual: OTC_MID_FEED_FLAG_ON_SYMBOL_MAP_EMPTY,
    };
  }
  if (input.liveObservationFeed) {
    return { wiring: 'live_observation', ...otcMidFeedStatus(true), residual: null };
  }
  return { wiring: 'flag_off', ...otcMidFeedStatus(false), residual: OTC_MID_FEED_RESIDUAL };
}

export function otcMidFeedStatus(liveObservationFeed = false) {
  if (liveObservationFeed) {
    return {
      published: true as const,
      socket: OTC_MID_FEED_SOCKET,
      residual: null,
      bootMapAllowed: false as const,
      liveObservationFeed: true as const,
    };
  }
  logRefusalSpec('trade.otc_no_reference_price');
  return {
    published: false as const,
    socket: OTC_MID_FEED_SOCKET,
    residual: OTC_MID_FEED_RESIDUAL,
    /** Honest label: config boot map exists in code but is not this socket closed. */
    bootMapAllowed: true as const,
    liveObservationFeed: false as const,
  };
}
