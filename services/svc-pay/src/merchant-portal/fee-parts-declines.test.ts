import { describe, expect, it } from 'vitest';
import { merchantAnalyticsDeclinesSchema } from '@intafaced/contracts';
import { feeParts } from '../control/snapshots.js';
import { safeFailure } from '../merchant-failure.js';
import { declineSummary } from './analytics.js';

/**
 * J-merchant-05 #5 (M-adv-payments-core-02): a stored fee shows its parts only when they add up to it exactly, an unknown
 * failure code reads as the generic sentence, and the decline rate is the service's own exact arithmetic.
 */
describe('fee parts from the stored snapshot row', () => {
  it('splits a TEST 1.50 fee into its percentage part and flat part, which add up', () => {
    expect(feeParts({ fee: '1.5', bpsFee: '1', flatFee: '0.5', feeBeforeClamp: '1.5' })).toEqual([
      { kind: 'percent', amount: '1' },
      { kind: 'flat', amount: '0.5' },
    ]);
  });

  it('names what a minimum added and what a maximum took off', () => {
    expect(feeParts({ fee: '0.5', bpsFee: '0.25', flatFee: null, feeBeforeClamp: '0.25' })).toEqual([
      { kind: 'percent', amount: '0.25' },
      { kind: 'minimum', amount: '0.25' },
    ]);
    expect(feeParts({ fee: '10', bpsFee: '12', flatFee: '0.3', feeBeforeClamp: '12.3' })).toEqual([
      { kind: 'percent', amount: '12' },
      { kind: 'flat', amount: '0.3' },
      { kind: 'maximum', amount: '2.3' },
    ]);
  });

  it('gives no split when the stored parts do not make the fee before the clamp, or a part was not stored', () => {
    expect(feeParts({ fee: '1.5', bpsFee: '1', flatFee: '0.4', feeBeforeClamp: '1.5' })).toBeNull();
    expect(feeParts({ fee: '1.5', bpsFee: null, flatFee: '0.5', feeBeforeClamp: '1.5' })).toBeNull();
    expect(feeParts({ fee: '1.5', bpsFee: '1', flatFee: '0.5', feeBeforeClamp: null })).toBeNull();
    expect(feeParts({ fee: 'x', bpsFee: '1', flatFee: '0.5', feeBeforeClamp: '1.5' })).toBeNull();
  });
});

describe('the failure catalogue', () => {
  it('collapses a code it does not list to the generic sentence, never the rail’s words', () => {
    expect(safeFailure('card.test_unlisted_reason')).toEqual({ code: 'pay.failed', message: 'The payment could not be completed.' });
    expect(safeFailure('card.declined')).toEqual({ code: 'card.declined', message: 'The card was declined.' });
  });
});

describe('declines worked out by the service', () => {
  const range = { from: '2026-10-05', to: '2026-10-19' };
  const at = '2026-11-05T00:00:00.000Z';
  const ok = (value: unknown) => merchantAnalyticsDeclinesSchema.parse(value);

  it('10 payments with 3 declines is 30 percent, with the reason split', () => {
    const read = declineSummary('m', range, at, [
      { status: 'captured', failure_code: null, n: 6 },
      { status: 'refunded', failure_code: null, n: 1 },
      { status: 'failed', failure_code: 'card.declined', n: 2 },
      { status: 'failed', failure_code: 'card.test_unlisted_reason', n: 1 },
    ]);
    expect(read).toMatchObject({
      finishedCount: 10,
      succeededCount: 7,
      declinedCount: 3,
      rate: '30',
      rateStatus: 'exact',
      reasons: [
        { code: 'card.declined', count: 2 },
        { code: 'pay.failed', message: 'The payment could not be completed.', count: 1 },
      ],
    });
    expect(() => ok({ ...read, merchantId: '7b0e8f5e-6d64-4a4c-9a55-4c6f1d3a7e11' })).not.toThrow();
  });

  it('rounds down to two places and says so; nothing finished carries no rate', () => {
    const third = declineSummary('m', range, at, [
      { status: 'captured', failure_code: null, n: 2 },
      { status: 'failed', failure_code: null, n: 1 },
    ]);
    expect([third.rate, third.rateStatus]).toEqual(['33.33', 'rounded']);
    const none = declineSummary('m', range, at, []);
    expect([none.rate, none.rateStatus, none.finishedCount]).toEqual([null, 'no_payments', 0]);
  });

  it('the wire refuses a rate that is not the rounded-down quotient', () => {
    const read = { ...declineSummary('m', range, at, [{ status: 'failed', failure_code: 'card.declined', n: 1 }]) };
    const merchantId = '7b0e8f5e-6d64-4a4c-9a55-4c6f1d3a7e11';
    expect(read.rate).toBe('100');
    expect(merchantAnalyticsDeclinesSchema.safeParse({ ...read, merchantId }).success).toBe(true);
    expect(merchantAnalyticsDeclinesSchema.safeParse({ ...read, merchantId, rate: '99' }).success).toBe(false);
    expect(merchantAnalyticsDeclinesSchema.safeParse({ ...read, merchantId, declinedCount: 2 }).success).toBe(false);
  });
});
