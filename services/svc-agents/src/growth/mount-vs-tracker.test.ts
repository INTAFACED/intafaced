import { describe, expect, it } from 'vitest';
import {
  agentsGrowthMountVsTrackerBoardCard,
  agentsGrowthTrackerBackendDoneBarMet,
  GROWTH_MOUNTED_DOORS,
  GROWTH_TRACKER_ID,
  growthDoorsInRouterSource,
} from './mount-vs-tracker.js';

describe('agents.growth mount vs tracker honest gaps (D26-P1-G1)', () => {
  it('backend done bar met on tip — proposals never publish', () => {
    expect(GROWTH_TRACKER_ID).toBe('agents.growth');
    expect(growthDoorsInRouterSource()).toEqual([...GROWTH_MOUNTED_DOORS]);
    expect(agentsGrowthTrackerBackendDoneBarMet()).toBe(true);
    expect(agentsGrowthMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
  });

  it('does not count a propose door that sits after the growth router object', () => {
    const src = [
      '    growth: router({',
      '      draft: scopedProcedure(),',
      '    }),',
      '    other: router({',
      '      propose: scopedProcedure(),',
      '    }),',
    ].join('\n');
    expect(growthDoorsInRouterSource(src)).toEqual([]);
  });
});
