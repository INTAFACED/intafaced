import { describe, expect, it } from 'vitest';
import { FEATURES } from '../../../../tooling/tracker/features.mjs';
import {
  COPY_HONEST_GAPS,
  COPY_TRACKER_ID,
  copyMountVsTrackerBoardCard,
  copyOwnerLawComposeGapsClosed,
  copyTrackerBackendDoneBarMet,
} from './mount-vs-tracker.js';

/** The tracker's own declared status for a feature, from its FEATURES list. */
function trackerStatus(featureId: string): string | null {
  return FEATURES.find((feature) => feature.id === featureId)?.status ?? null;
}

describe('trade.copy tracker status pin', () => {
  it('fee-share + jurisdiction compose gaps closed; socket residuals remain honest', () => {
    expect(copyOwnerLawComposeGapsClosed()).toBe(true);
    expect(COPY_HONEST_GAPS).toEqual(['gap.auto_mirror_place_socket', 'gap.no_returns_ranked_board']);
    expect(copyTrackerBackendDoneBarMet()).toBe(true);
    expect(copyMountVsTrackerBoardCard().gaps).toBe(2);
  });

  it('features.mjs marks trade.copy done when owner-law wiring ships', () => {
    expect(COPY_TRACKER_ID).toBe('trade.copy');
    expect(trackerStatus('trade.copy')).toBe('done');
  });
});
