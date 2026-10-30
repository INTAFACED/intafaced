import { describe, expect, it } from 'vitest';
import { EVENT_CATALOG, WITHDRAWAL_STATUS_VALUES, payWithdrawalStatusUpdatedPayloadSchema, wiringSocketReason } from './catalog.js';

/** TEST data only. */
const base = {
  withdrawalId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  attempt: 0,
  from: 'held',
  to: 'broadcast',
  failureCode: null,
  occurredAt: '2026-10-30T00:00:00.000Z',
} as const;

describe('payWithdrawalStatusUpdated', () => {
  it('is declared on the pay service with a past-tense subject', () => {
    expect(EVENT_CATALOG.payWithdrawalStatusUpdated.subject).toBe('intafaced.pay.withdrawal_status.updated');
    expect(EVENT_CATALOG.payWithdrawalStatusUpdated.version).toBe(1);
    expect(payWithdrawalStatusUpdatedPayloadSchema.parse(base)).toEqual(base);
  });

  it('carries exactly the twelve ENGINE W-1 words and nothing else', () => {
    expect(WITHDRAWAL_STATUS_VALUES).toHaveLength(12);
    for (const to of WITHDRAWAL_STATUS_VALUES) {
      const failureCode = to === 'failed' || to === 'rejected' ? 'rail.refused' : null;
      expect(payWithdrawalStatusUpdatedPayloadSchema.safeParse({ ...base, from: null, to, failureCode }).success, to).toBe(true);
    }
    // The stored words are not on the wire: an old `sent` row is published as `settled`.
    for (const to of ['sent', 'pending', 'Settled', '']) {
      expect(payWithdrawalStatusUpdatedPayloadSchema.safeParse({ ...base, to }).success, to).toBe(false);
    }
  });

  it('opens a withdrawal with no previous status, and refuses a move that changes nothing', () => {
    expect(payWithdrawalStatusUpdatedPayloadSchema.safeParse({ ...base, from: null, to: 'requested' }).success).toBe(true);
    expect(payWithdrawalStatusUpdatedPayloadSchema.safeParse({ ...base, from: 'held', to: 'held' }).success).toBe(false);
  });

  it('names a failure code exactly when the withdrawal failed or was rejected', () => {
    expect(payWithdrawalStatusUpdatedPayloadSchema.safeParse({ ...base, to: 'failed', failureCode: 'rail.refused' }).success).toBe(true);
    expect(payWithdrawalStatusUpdatedPayloadSchema.safeParse({ ...base, to: 'failed', failureCode: null }).success).toBe(false);
    expect(payWithdrawalStatusUpdatedPayloadSchema.safeParse({ ...base, to: 'rejected', failureCode: null }).success).toBe(false);
    expect(payWithdrawalStatusUpdatedPayloadSchema.safeParse({ ...base, to: 'settled', failureCode: 'rail.refused' }).success).toBe(false);
    expect(payWithdrawalStatusUpdatedPayloadSchema.safeParse({ ...base, to: 'failed', failureCode: 'Rail Refused' }).success).toBe(false);
  });

  it('refuses a move without its withdrawal, person, attempt or time, a fractional or negative attempt, and extra fields', () => {
    for (const key of ['withdrawalId', 'userId', 'attempt', 'occurredAt', 'to'] as const) {
      const { [key]: _gone, ...rest } = base;
      expect(payWithdrawalStatusUpdatedPayloadSchema.safeParse(rest).success, key).toBe(false);
    }
    expect(payWithdrawalStatusUpdatedPayloadSchema.safeParse({ ...base, attempt: 1.5 }).success).toBe(false);
    expect(payWithdrawalStatusUpdatedPayloadSchema.safeParse({ ...base, attempt: -1 }).success).toBe(false);
    expect(payWithdrawalStatusUpdatedPayloadSchema.safeParse({ ...base, withdrawalId: 'w-1' }).success).toBe(false);
    // No amount on the wire: the ledger is the record of value.
    expect(payWithdrawalStatusUpdatedPayloadSchema.safeParse({ ...base, amount: '12' }).success).toBe(false);
  });

  it('names both missing ends until svc-pay publishes it and a notice subscribes', () => {
    expect(wiringSocketReason('payWithdrawalStatusUpdated', 'publisher')).toMatch(/svc-pay/);
    expect(wiringSocketReason('payWithdrawalStatusUpdated', 'subscriber')).toMatch(/svc-notify/);
  });
});
