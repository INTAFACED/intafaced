import { describe, expect, it } from 'vitest';
import { FEATURES } from '../../../../tooling/tracker/features.mjs';
import {
  FOREX_HONEST_GAPS,
  FOREX_TRACKER_ID,
  forexMountVsTrackerBoardCard,
  forexOwnerEnvComposeGapsClosed,
  forexTrackerBackendDoneBarMet,
} from './forex-mount-vs-tracker.js';

/** The tracker's own declared status for a feature, from its FEATURES list. */
function trackerStatus(featureId: string): string | null {
  return FEATURES.find((feature) => feature.id === featureId)?.status ?? null;
}

describe('trade.forex tracker status pin', () => {
  it('P0-05 compose gap closed; fiat settle rails residual remains', () => {
    expect(forexOwnerEnvComposeGapsClosed()).toBe(true);
    expect(FOREX_HONEST_GAPS).toEqual(['gap.fiat_settle_rails']);
    expect(forexTrackerBackendDoneBarMet()).toBe(true);
    expect(forexMountVsTrackerBoardCard().gaps).toBe(1);
  });

  it('features.mjs marks trade.forex done when owner env wiring ships', () => {
    expect(FOREX_TRACKER_ID).toBe('trade.forex');
    expect(trackerStatus('trade.forex')).toBe('done');
  });
});
