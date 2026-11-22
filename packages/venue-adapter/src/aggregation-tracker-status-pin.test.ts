import { describe, expect, it } from 'vitest';
import { FEATURES } from '../../../tooling/tracker/features.mjs';
import {
  VENUE_AGGREGATION_HONEST_GAPS,
  venueAggregationMountVsTrackerBoardCard,
  venueAggregationTrackerBackendDoneBarMet,
} from './aggregation-mount-vs-tracker.js';

/** The tracker's own declared status for a feature, from its FEATURES list. */
function trackerStatus(featureId: string): string | null {
  return FEATURES.find((feature) => feature.id === featureId)?.status ?? null;
}

describe('venue.aggregation tracker status pin', () => {
  it('honest gaps are closed and backend done bar is met', () => {
    expect(VENUE_AGGREGATION_HONEST_GAPS).toEqual([]);
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationMountVsTrackerBoardCard().gaps).toBe(0);
  });

  it('features.mjs marks venue.aggregation done when product gaps are closed', () => {
    expect(trackerStatus('venue.aggregation')).toBe('done');
  });
});
