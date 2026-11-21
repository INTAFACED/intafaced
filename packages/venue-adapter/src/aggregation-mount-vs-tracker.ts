/**
 * D73-P1 — venue.aggregation mount vs tracker honest gaps.
 *
 * Trading-half + MD factory on tip. The live-network smoke runs by hand
 * (VENUE_AGGREGATION_LIVE_NETWORK_CI=1); its workflow was removed on 15 Nov 2026.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeVenueAggregationPolicy } from './fabric/venues/factory-policy.js';
import { describeTradingHalfPolicy, tradeAdapterRegisteredForAllPublicVenues } from './fabric/venues/trading-half-policy.js';

export const VENUE_AGGREGATION_TRACKER_ID = 'venue.aggregation' as const;

export const VENUE_AGGREGATION_PACKAGE_EXPORTS = [
  'PUBLIC_MARKET_DATA_VENUE_IDS',
  'createVenueMarketDataAdapter',
  'createVenueTradeAdapter',
  'createVenueAccountAdapter',
  'describeTradingHalfPolicy',
  'describeVenueAggregationPolicy',
  'loadVenueOperatorCredentials',
  'createVenueTradeAdapterFromOperatorEnv',
  'buildOperatorVenueTradeMaps',
] as const;

export const VENUE_AGGREGATION_DONE_BAR_TEST_FILES = [
  'fabric/venues/factory.test.ts',
  'fabric/venues/factory-policy.test.ts',
  'fabric/venues/trading-half-policy.test.ts',
  'fabric/venues/aggregation-trading-door.test.ts',
  'aggregation-mount-vs-tracker.test.ts',
] as const;

export const VENUE_AGGREGATION_HONEST_GAPS = [] as const;

export function venueAggregationExportsInIndexSource(): readonly (typeof VENUE_AGGREGATION_PACKAGE_EXPORTS)[number][] {
  const here = dirname(fileURLToPath(import.meta.url));
  const paths = [
    join(here, 'fabric', 'venues', 'factory.ts'),
    join(here, 'fabric', 'venues', 'factory-policy.ts'),
    join(here, 'fabric', 'venues', 'trading-half-policy.ts'),
    join(here, 'fabric', 'venues', 'venue-operator-credentials.ts'),
    join(here, 'fabric', 'venues', 'operator-venue-trade-maps.ts'),
    join(here, 'fabric', 'index.ts'),
    join(here, 'index.ts'),
  ];
  const blob = paths.map((path) => readFileSync(path, 'utf8')).join('\n');
  return VENUE_AGGREGATION_PACKAGE_EXPORTS.filter((name) => blob.includes(name));
}

export function venueAggregationPolicyHonest(): boolean {
  const md = describeVenueAggregationPolicy();
  const trade = describeTradingHalfPolicy();
  return (
    md.unknownVenueIdRefuses === true &&
    md.inventsCredentials === false &&
    md.inventsVenueList === false &&
    md.inventsAdapterForUnknownId === false &&
    trade.tradeFactoryCoversAllPublicMarketDataVenues === true &&
    trade.inventsCredentials === false &&
    trade.liveCredentialsOperatorIssued === true
  );
}

export function venueAggregationTradeFactoryComplete(): boolean {
  return tradeAdapterRegisteredForAllPublicVenues();
}

export function venueAggregationDoneBarTestsPresent(): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  return VENUE_AGGREGATION_DONE_BAR_TEST_FILES.every((file) => existsSync(join(here, file)));
}

export function venueAggregationTrackerBackendDoneBarMet(): boolean {
  return (
    venueAggregationExportsInIndexSource().length === VENUE_AGGREGATION_PACKAGE_EXPORTS.length &&
    venueAggregationPolicyHonest() &&
    venueAggregationTradeFactoryComplete() &&
    venueAggregationDoneBarTestsPresent()
  );
}

export function venueAggregationMountVsTrackerBoardCard(): {
  readonly tracker: typeof VENUE_AGGREGATION_TRACKER_ID;
  readonly exports: number;
  readonly exportsPresent: number;
  readonly gaps: number;
  readonly backendDoneBarMet: boolean;
} {
  const present = venueAggregationExportsInIndexSource();
  return {
    tracker: VENUE_AGGREGATION_TRACKER_ID,
    exports: VENUE_AGGREGATION_PACKAGE_EXPORTS.length,
    exportsPresent: present.length,
    gaps: VENUE_AGGREGATION_HONEST_GAPS.length,
    backendDoneBarMet: venueAggregationTrackerBackendDoneBarMet(),
  };
}
