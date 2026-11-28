import { describe, expect, it } from 'vitest';
import { FEATURES } from '../../../tooling/tracker/features.mjs';
import {
  ALERTS_HONEST_GAPS,
  ALERTS_TRACKER_ID,
  alertsMountVsTrackerBoardCard,
  alertsTrackerBackendDoneBarMet,
} from './alerts-mount-vs-tracker.js';

/** The tracker's own declared status for a feature, from its FEATURES list. */
function trackerStatus(featureId: string): string | null {
  return FEATURES.find((feature) => feature.id === featureId)?.status ?? null;
}

describe('v22.alerts tracker status pin', () => {
  it('sourced-mark watches shipped; intelligence/mobile/gateway gaps remain', () => {
    expect(alertsTrackerBackendDoneBarMet()).toBe(true);
    expect(ALERTS_HONEST_GAPS).toEqual(['gap.intelligence_kind', 'gap.mobile_sync', 'gap.out_of_app_gateway_credentials']);
    expect(alertsMountVsTrackerBoardCard().gaps).toBe(3);
  });

  it('features.mjs marks v22.alerts done when backend done bar met', () => {
    expect(ALERTS_TRACKER_ID).toBe('v22.alerts');
    expect(trackerStatus('v22.alerts')).toBe('done');
  });
});
