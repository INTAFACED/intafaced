import { describe, expect, it } from 'vitest';
import { FEATURES } from '../../../../tooling/tracker/features.mjs';
import {
  OPTIONS_HONEST_GAPS,
  OPTIONS_TRACKER_ID,
  optionsMountVsTrackerBoardCard,
  optionsOwnerEnvComposeGapsClosed,
  optionsTrackerBackendDoneBarMet,
} from './options-mount-vs-tracker.js';

/** The tracker's own declared status for a feature, from its FEATURES list. */
function trackerStatus(featureId: string): string | null {
  return FEATURES.find((feature) => feature.id === featureId)?.status ?? null;
}

describe('trade.options tracker status pin', () => {
  it('P0-05 + D7 compose gaps closed; paper engine shipped; live settlement residual remains', () => {
    expect(optionsOwnerEnvComposeGapsClosed()).toBe(true);
    expect(OPTIONS_HONEST_GAPS).toEqual(['gap.live_options_settlement']);
    expect(optionsTrackerBackendDoneBarMet()).toBe(true);
    expect(optionsMountVsTrackerBoardCard().gaps).toBe(1);
  });

  it('features.mjs marks trade.options done when owner env wiring ships', () => {
    expect(OPTIONS_TRACKER_ID).toBe('trade.options');
    expect(trackerStatus('trade.options')).toBe('done');
  });
});
