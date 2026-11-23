import { describe, expect, it } from 'vitest';
import { PUBLIC_MARKET_DATA_VENUE_IDS } from './factory.js';
import { describeVenueAggregationPolicy } from './factory-policy.js';
import * as fabric from '../index.js';

describe('describeVenueAggregationPolicy — venue.aggregation honesty door', () => {
  it('states factory honesty without inventing venues or credentials', () => {
    const p = describeVenueAggregationPolicy();
    expect(p.publicMarketDataVenueIds).toEqual([...PUBLIC_MARKET_DATA_VENUE_IDS]);
    expect(p.publicMarketDataVenueIds).toEqual(['binance-spot', 'bybit-spot', 'okx-spot']);
    expect(p.unknownVenueIdRefuses).toBe(true);
    expect(p.offNoneFalseRefuses).toBe(true);
    expect(p.publicMarketDataOnly).toBe(true);
    expect(p.signedTradeSeparateFactory).toBe(true);
    expect(p.inventsCredentials).toBe(false);
    expect(p.inventsVenueList).toBe(false);
    expect(p.inventsAdapterForUnknownId).toBe(false);
  });
});

describe('factory-policy public door — fabric export seal', () => {
  it('fabric/index exports the factory policy door itself', () => {
    expect(fabric.describeVenueAggregationPolicy).toBe(describeVenueAggregationPolicy);
    expect(fabric.describeVenueAggregationPolicy().inventsVenueList).toBe(false);
  });
});
