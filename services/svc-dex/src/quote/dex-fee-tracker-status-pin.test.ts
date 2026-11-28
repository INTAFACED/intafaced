import { describe, expect, it } from 'vitest';
import { FEATURES } from '../../../../tooling/tracker/features.mjs';
import {
  DEX_FEE_HONEST_GAPS,
  DEX_FEE_SOURCE_TRACKER_ID,
  dexFeeOwnerEnvComposeGapsClosed,
  dexFeeSourceMountVsTrackerBoardCard,
  dexFeeSourceTrackerBackendDoneBarMet,
} from './dex-fee-mount-vs-tracker.js';

/** The tracker's own declared status for a feature, from its FEATURES list. */
function trackerStatus(featureId: string): string | null {
  return FEATURES.find((feature) => feature.id === featureId)?.status ?? null;
}

describe('socket.dex-fee-source tracker status pin', () => {
  it('CLOB fee compose gaps closed; internal-book + eth_call residuals remain', () => {
    expect(dexFeeOwnerEnvComposeGapsClosed()).toBe(true);
    expect(DEX_FEE_HONEST_GAPS).toEqual(['gap.internal_book_fee_not_sourced', 'gap.clob_projection_not_eth_call']);
    expect(dexFeeSourceTrackerBackendDoneBarMet()).toBe(true);
    expect(dexFeeSourceMountVsTrackerBoardCard().gaps).toBe(2);
  });

  it('features.mjs marks socket.dex-fee-source done when owner env wiring ships', () => {
    expect(DEX_FEE_SOURCE_TRACKER_ID).toBe('socket.dex-fee-source');
    expect(trackerStatus('socket.dex-fee-source')).toBe('done');
  });
});
