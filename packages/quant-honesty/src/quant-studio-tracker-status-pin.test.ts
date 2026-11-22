import { describe, expect, it } from 'vitest';
import { FEATURES } from '../../../tooling/tracker/features.mjs';
import {
  QUANT_STUDIO_HONEST_GAPS,
  QUANT_STUDIO_TRACKER_ID,
  quantStudioMountVsTrackerBoardCard,
  quantStudioTrackerBackendDoneBarMet,
} from './quant-studio-mount-vs-tracker.js';

/** The tracker's own declared status for a feature, from its FEATURES list. */
function trackerStatus(featureId: string): string | null {
  return FEATURES.find((feature) => feature.id === featureId)?.status ?? null;
}

describe('quant.studio tracker status pin', () => {
  it('contract boundary + visual builder shipped; sandbox escape remains an honest gap', () => {
    expect(quantStudioTrackerBackendDoneBarMet()).toBe(true);
    expect(QUANT_STUDIO_HONEST_GAPS).toHaveLength(1);
    expect(quantStudioMountVsTrackerBoardCard().gaps).toBe(1);
  });

  it('features.mjs marks quant.studio done when contract + data-lake dep ship', () => {
    expect(QUANT_STUDIO_TRACKER_ID).toBe('quant.studio');
    expect(trackerStatus('quant.studio')).toBe('done');
  });
});
