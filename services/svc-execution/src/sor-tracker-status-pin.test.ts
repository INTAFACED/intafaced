import { describe, expect, it } from 'vitest';
import { FEATURES } from '../../../tooling/tracker/features.mjs';
import {
  EXECUTION_SOR_HONEST_GAPS,
  executionSorMountVsTrackerBoardCard,
  executionSorTrackerBackendDoneBarMet,
} from './mount-vs-tracker.js';

/** The tracker's own declared status for a feature, from its FEATURES list. */
function trackerStatus(featureId: string): string | null {
  return FEATURES.find((feature) => feature.id === featureId)?.status ?? null;
}

describe('execution.sor tracker status pin', () => {
  it('honest gaps are closed and backend done bar is met', () => {
    expect(EXECUTION_SOR_HONEST_GAPS).toEqual([]);
    expect(executionSorTrackerBackendDoneBarMet()).toBe(true);
    expect(executionSorMountVsTrackerBoardCard().gaps).toBe(0);
  });

  it('features.mjs marks execution.sor done when product gaps are closed', () => {
    expect(trackerStatus('execution.sor')).toBe('done');
  });
});
