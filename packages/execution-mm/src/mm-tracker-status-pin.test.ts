import { describe, expect, it } from 'vitest';
import { FEATURES } from '../../../tooling/tracker/features.mjs';
import {
  EXECUTION_MM_TRACKER_ID,
  executionMmMountVsTrackerBoardCard,
  executionMmTrackerBackendDoneBarMet,
  MM_HONEST_GAPS,
  mmSpreadSkewBandsGapsClosed,
} from './mount-vs-tracker.js';

/** The tracker's own declared status for a feature, from its FEATURES list. */
function trackerStatus(featureId: string): string | null {
  return FEATURES.find((feature) => feature.id === featureId)?.status ?? null;
}

describe('execution.market-making tracker status pin', () => {
  it('spread/skew compose gap closed; internal half remains ADR-blocked', () => {
    expect(mmSpreadSkewBandsGapsClosed()).toBe(true);
    expect(MM_HONEST_GAPS).toEqual(['gap.internal_venue_mm_blocked']);
    expect(executionMmTrackerBackendDoneBarMet()).toBe(true);
    expect(executionMmMountVsTrackerBoardCard().gaps).toBe(1);
  });

  it('features.mjs marks execution.market-making done when external half ships', () => {
    expect(EXECUTION_MM_TRACKER_ID).toBe('execution.market-making');
    expect(trackerStatus('execution.market-making')).toBe('done');
  });
});
