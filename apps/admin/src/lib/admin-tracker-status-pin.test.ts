import { describe, expect, it } from 'vitest';
import { FEATURES } from '../../../../tooling/tracker/features.mjs';
import {
  OPS_ADMIN_HONEST_GAPS,
  OPS_ADMIN_TRACKER_ID,
  opsAdminMountVsTrackerBoardCard,
  opsAdminTrackerBackendDoneBarMet,
} from './admin-mount-vs-tracker.js';

/** The tracker's own declared status for a feature, from its FEATURES list. */
function trackerStatus(featureId: string): string | null {
  return FEATURES.find((feature) => feature.id === featureId)?.status ?? null;
}

describe('ops.admin tracker status pin', () => {
  it('operator console shipped; fee writes + SSO ACL gaps remain honest', () => {
    expect(opsAdminTrackerBackendDoneBarMet()).toBe(true);
    expect(OPS_ADMIN_HONEST_GAPS).toEqual(['gap.fee_listing_write_paths', 'gap.class_x_sso_acl']);
    expect(opsAdminMountVsTrackerBoardCard().gaps).toBe(2);
  });

  it('features.mjs marks ops.admin done when backend done bar met', () => {
    expect(OPS_ADMIN_TRACKER_ID).toBe('ops.admin');
    expect(trackerStatus('ops.admin')).toBe('done');
  });
});
