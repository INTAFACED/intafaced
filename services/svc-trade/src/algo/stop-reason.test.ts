/** CB-bots-01 — documented stop reasons on "My bots". */
import { describe, expect, it } from 'vitest';
import { ALGO_STOP_REASONS, algoStopReason } from './stop-reason.js';
import { CANCEL_INCOMPLETE_HALT } from './twap-engine.js';
import type { AlgoMiss, AlgoMissCode, AlgoStatus } from './types.js';

const at = new Date('2026-10-22T00:00:00.000Z');
const miss = (code: AlgoMissCode): AlgoMiss => ({ sliceIndex: 0, code, reason: `TEST ${code}`, at });
const parent = (status: AlgoStatus, haltReason: string | null, misses: AlgoMiss[] = []) => ({ status, haltReason, misses });

describe('algoStopReason', () => {
  it.each<AlgoStatus>(['active', 'paused', 'completed', 'cancelled'])('%s parent without a halt has no stop reason', (status) => {
    expect(algoStopReason(parent(status, null))).toBeNull();
  });

  it('cancel-incomplete reads "Cancel incomplete"', () => {
    expect(algoStopReason(parent('halted', CANCEL_INCOMPLETE_HALT))).toEqual({
      code: 'cancel_incomplete',
      label: 'Cancel incomplete',
    });
    // The marker wins even when the parent status is still cancelled.
    expect(algoStopReason(parent('cancelled', CANCEL_INCOMPLETE_HALT))?.code).toBe('cancel_incomplete');
  });

  it.each<[AlgoMissCode, string]>([
    ['trade.algo_no_liquidity', 'no_liquidity'],
    ['trade.algo_price_band', 'price_band'],
    ['trade.algo_mark_unusable', 'mark_unavailable'],
    ['trade.algo_mark_missing', 'mark_unavailable'],
    ['trade.algo_insufficient_balance', 'insufficient_balance'],
    ['trade.algo_market_closed', 'market_closed'],
    ['trade.algo_principal_unavailable', 'account_unavailable'],
    ['trade.algo_child_refused', 'order_refused'],
    ['trade.algo_no_volume', 'no_volume'],
  ])('halt on %s reads %s', (code, expected) => {
    const out = algoStopReason(parent('halted', `TEST ${code}`, [miss(code)]));
    expect(out?.code).toBe(expected);
    expect(out?.label).toBe(ALGO_STOP_REASONS[expected as keyof typeof ALGO_STOP_REASONS]);
  });

  it('uses the last miss, the one that halted the schedule', () => {
    const out = algoStopReason(parent('halted', 'x', [miss('trade.algo_no_liquidity'), miss('trade.algo_market_closed')]));
    expect(out?.code).toBe('market_closed');
  });

  it('a halt with no typed miss is "not recorded", never a guessed reason', () => {
    expect(algoStopReason(parent('halted', 'something', []))).toEqual({ code: 'unrecorded', label: 'Stop reason not recorded' });
    expect(algoStopReason(parent('halted', 'x', [miss('trade.algo_unknown' as AlgoMissCode)]))?.code).toBe('unrecorded');
  });

  it('documents the reasons other bot engines emit', () => {
    expect(ALGO_STOP_REASONS.delisting).toBe('Delisting');
    expect(ALGO_STOP_REASONS.liquidation).toBe('Liquidation');
    expect(ALGO_STOP_REASONS.position_limit).toBe('Position limit');
    expect(ALGO_STOP_REASONS.contract_change).toBe('Contract parameter change');
    expect(ALGO_STOP_REASONS.copied_lead_stop).toBe('Copied lead stopped');
  });
});
