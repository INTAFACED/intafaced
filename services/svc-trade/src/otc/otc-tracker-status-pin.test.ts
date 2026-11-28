import { describe, expect, it } from 'vitest';
import { FEATURES } from '../../../../tooling/tracker/features.mjs';
import {
  OTC_HONEST_GAPS,
  OTC_TRACKER_ID,
  otcDeskLawComposeGapsClosed,
  otcMountVsTrackerBoardCard,
  otcTrackerBackendDoneBarMet,
} from './mount-vs-tracker.js';

/** The tracker's own declared status for a feature, from its FEATURES list. */
function trackerStatus(featureId: string): string | null {
  return FEATURES.find((feature) => feature.id === featureId)?.status ?? null;
}

describe('trade.otc tracker status pin', () => {
  it('desk-law compose gap closed; socket residuals remain honest', () => {
    expect(otcDeskLawComposeGapsClosed()).toBe(true);
    expect(OTC_HONEST_GAPS).toEqual(['gap.socket_otc_maker_routing', 'gap.connect_venue_vault_custody']);
    expect(otcTrackerBackendDoneBarMet()).toBe(true);
    expect(otcMountVsTrackerBoardCard().gaps).toBe(2);
  });

  it('features.mjs marks trade.otc done when desk-law wiring ships', () => {
    expect(OTC_TRACKER_ID).toBe('trade.otc');
    expect(trackerStatus('trade.otc')).toBe('done');
  });
});
