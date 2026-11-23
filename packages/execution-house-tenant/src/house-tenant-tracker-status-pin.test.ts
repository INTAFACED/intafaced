import { describe, expect, it } from 'vitest';
import { FEATURES } from '../../../tooling/tracker/features.mjs';
import {
  HOUSE_TENANT_HONEST_GAPS,
  HOUSE_TENANT_TRACKER_ID,
  houseTenantMountVsTrackerBoardCard,
  houseTenantTrackerBackendDoneBarMet,
} from './mount-vs-tracker.js';

/** The tracker's own declared status for a feature, from its FEATURES list. */
function trackerStatus(featureId: string): string | null {
  return FEATURES.find((feature) => feature.id === featureId)?.status ?? null;
}

describe('execution.house-tenant tracker status pin', () => {
  it('external-only mechanism shipped; internal half + disclosure gaps remain', () => {
    expect(houseTenantTrackerBackendDoneBarMet()).toBe(true);
    expect(HOUSE_TENANT_HONEST_GAPS).toEqual(['gap.internal_venue_half', 'gap.existence_disclosure_deferred']);
    expect(houseTenantMountVsTrackerBoardCard().gaps).toBe(2);
  });

  it('features.mjs marks execution.house-tenant done when mechanism ships', () => {
    expect(HOUSE_TENANT_TRACKER_ID).toBe('execution.house-tenant');
    expect(trackerStatus('execution.house-tenant')).toBe('done');
  });
});
