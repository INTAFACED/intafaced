import { describe, expect, it } from 'vitest';
import { FEATURES } from '../../../tooling/tracker/features.mjs';
import {
  QUANT_BACKTEST_HONEST_GAPS,
  QUANT_BACKTEST_TRACKER_ID,
  quantBacktestMountVsTrackerBoardCard,
  quantBacktestTrackerBackendDoneBarMet,
} from './quant-backtest-mount-vs-tracker.js';

/** The tracker's own declared status for a feature, from its FEATURES list. */
function trackerStatus(featureId: string): string | null {
  return FEATURES.find((feature) => feature.id === featureId)?.status ?? null;
}

describe('quant.backtest tracker status pin', () => {
  it('contract boundary + event engine shipped; Monte Carlo remains an honest gap', () => {
    expect(quantBacktestTrackerBackendDoneBarMet()).toBe(true);
    expect(QUANT_BACKTEST_HONEST_GAPS).toHaveLength(1);
    expect(quantBacktestMountVsTrackerBoardCard().gaps).toBe(1);
  });

  it('features.mjs marks quant.backtest done when contract + deps ship', () => {
    expect(QUANT_BACKTEST_TRACKER_ID).toBe('quant.backtest');
    expect(trackerStatus('quant.backtest')).toBe('done');
  });
});
