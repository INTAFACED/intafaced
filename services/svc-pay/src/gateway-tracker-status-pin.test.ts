import { describe, expect, it } from 'vitest';
import { FEATURES } from '../../../tooling/tracker/features.mjs';
import {
  GATEWAY_HONEST_GAPS,
  PAY_GATEWAY_TRACKER_ID,
  payGatewayMountVsTrackerBoardCard,
  payGatewayTrackerBackendDoneBarMet,
} from './gateway-mount-vs-tracker.js';

/** The tracker's own declared status for a feature, from its FEATURES list. */
function trackerStatus(featureId: string): string | null {
  return FEATURES.find((feature) => feature.id === featureId)?.status ?? null;
}

describe('pay.gateway tracker status pin', () => {
  it('hosted checkout + merchant lifecycle shipped; card/KYB socket residuals remain', () => {
    expect(payGatewayTrackerBackendDoneBarMet()).toBe(true);
    expect(GATEWAY_HONEST_GAPS).toEqual(['gap.card_acquiring_absent_not_sandbox', 'gap.kyb_status_no_consumer', 'gap.socket_psp_partners']);
    expect(payGatewayMountVsTrackerBoardCard().gaps).toBe(3);
  });

  it('features.mjs marks pay.gateway done when backend done bar met', () => {
    expect(PAY_GATEWAY_TRACKER_ID).toBe('pay.gateway');
    expect(trackerStatus('pay.gateway')).toBe('done');
  });
});
