import { describe, expect, it } from 'vitest';
import { FEATURES } from '../../../../tooling/tracker/features.mjs';
import {
  RWA_HONEST_GAPS,
  RWA_TRACKER_ID,
  launchRwaMountVsTrackerBoardCard,
  launchRwaTrackerBackendDoneBarMet,
} from './rwa-mount-vs-tracker.js';

/** The tracker's own declared status for a feature, from its FEATURES list. */
function trackerStatus(featureId: string): string | null {
  return FEATURES.find((feature) => feature.id === featureId)?.status ?? null;
}

describe('launch.rwa tracker status pin', () => {
  it('registry contract + honesty + forge done bar met; licence content Class X residual', () => {
    expect(launchRwaTrackerBackendDoneBarMet()).toBe(true);
    expect(RWA_HONEST_GAPS).toEqual(['gap.licence_content_class_x', 'gap.contract_unaudited']);
    expect(launchRwaMountVsTrackerBoardCard().gaps).toBe(2);
  });

  it('features.mjs marks launch.rwa done when backend done bar met', () => {
    expect(RWA_TRACKER_ID).toBe('launch.rwa');
    expect(trackerStatus('launch.rwa')).toBe('done');
  });
});
