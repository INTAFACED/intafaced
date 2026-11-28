import { describe, expect, it } from 'vitest';
import { FEATURES } from '../../../../tooling/tracker/features.mjs';
import {
  TREASURY_YIELD_HONEST_GAPS,
  TREASURY_YIELD_TRACKER_ID,
  launchTreasuryYieldMountVsTrackerBoardCard,
  launchTreasuryYieldTrackerBackendDoneBarMet,
} from './treasury-yield-mount-vs-tracker.js';

/** The tracker's own declared status for a feature, from its FEATURES list. */
function trackerStatus(featureId: string): string | null {
  return FEATURES.find((feature) => feature.id === featureId)?.status ?? null;
}

describe('launch.treasury-yield tracker status pin', () => {
  it('vault contract + honesty done bar met; licence content Class X residual', () => {
    expect(launchTreasuryYieldTrackerBackendDoneBarMet()).toBe(true);
    expect(TREASURY_YIELD_HONEST_GAPS).toEqual(['gap.licence_content_class_x', 'gap.contract_unaudited']);
    expect(launchTreasuryYieldMountVsTrackerBoardCard().gaps).toBe(2);
  });

  it('features.mjs marks launch.treasury-yield done when backend done bar met', () => {
    expect(TREASURY_YIELD_TRACKER_ID).toBe('launch.treasury-yield');
    expect(trackerStatus('launch.treasury-yield')).toBe('done');
  });
});
