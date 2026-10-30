import { describe, expect, it } from 'vitest';
import { EVENT_CATALOG, WITHDRAWAL_STATUS_VALUES, payWithdrawalStatusUpdatedPayloadSchema, wiringSocketReason } from './catalog.js';

/** TEST data only. */
const base = {
  withdrawalId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  seq: 3,
  attempt: 0,
  from: 'held',
  to: 'broadcast',
  failureCode: null,
  occurredAt: '2026-10-30T00:00:00.000Z',
} as const;
const ok = (patch: Record<string, unknown>) => payWithdrawalStatusUpdatedPayloadSchema.safeParse({ ...base, ...patch }).success;

describe('payWithdrawalStatusUpdated', () => {
  it('is declared on the pay service with a past-tense subject', () => {
    expect(EVENT_CATALOG.payWithdrawalStatusUpdated.subject).toBe('intafaced.pay.withdrawal_status.updated');
    expect(EVENT_CATALOG.payWithdrawalStatusUpdated.version).toBe(1);
    expect(payWithdrawalStatusUpdatedPayloadSchema.parse(base)).toEqual(base);
  });

  it('carries exactly the twelve ENGINE W-1 words and nothing else', () => {
    expect(WITHDRAWAL_STATUS_VALUES).toHaveLength(12);
    for (const to of WITHDRAWAL_STATUS_VALUES) {
      if (to === 'held') continue;
      const failureCode = to === 'failed' || to === 'rejected' ? 'rail.refused' : null;
      expect(ok({ to, failureCode }), to).toBe(true);
    }
    // The stored words (`pending`, `sent`) are not wire words; svc-pay maps them before it publishes.
    for (const to of ['sent', 'pending', 'Settled', '']) expect(ok({ to }), to).toBe(false);
  });

  it('opens a withdrawal with seq 1, no previous status and requested, and only then', () => {
    expect(ok({ seq: 1, from: null, to: 'requested' })).toBe(true);
    expect(ok({ seq: 1, from: null, to: 'settled' })).toBe(false);
    expect(ok({ seq: 2, from: null, to: 'requested' })).toBe(false);
    expect(ok({ seq: 1, from: 'requested', to: 'held' })).toBe(false);
    expect(ok({ seq: 0, from: null, to: 'requested' })).toBe(false);
  });

  it('refuses a move that changes nothing, and tells a move back into a status apart by its seq', () => {
    expect(ok({ from: 'held', to: 'held' })).toBe(false);
    // pending_review -> needs_review -> pending_review: two moves to the same status, each its own fact.
    expect(ok({ seq: 2, from: 'requested', to: 'pending_review' })).toBe(true);
    expect(ok({ seq: 4, from: 'needs_review', to: 'pending_review' })).toBe(true);
  });

  it('names a failure code on failed and rejected, and carries one on any other status that has it', () => {
    expect(ok({ to: 'failed', failureCode: 'rail.refused' })).toBe(true);
    expect(ok({ to: 'failed', failureCode: null })).toBe(false);
    expect(ok({ to: 'rejected', failureCode: null })).toBe(false);
    expect(ok({ from: 'dispatching', to: 'needs_review', failureCode: 'rail.outcome_unknown' })).toBe(true);
    expect(ok({ to: 'failed', failureCode: 'Rail Refused' })).toBe(false);
  });

  it('refuses a move without its withdrawal, person, seq, attempt or time, a bad number, and extra fields', () => {
    for (const key of ['withdrawalId', 'userId', 'seq', 'attempt', 'occurredAt', 'to'] as const) {
      const { [key]: _gone, ...rest } = base;
      expect(payWithdrawalStatusUpdatedPayloadSchema.safeParse(rest).success, key).toBe(false);
    }
    expect(ok({ attempt: 1.5 })).toBe(false);
    expect(ok({ attempt: -1 })).toBe(false);
    expect(ok({ seq: 2.5 })).toBe(false);
    expect(ok({ withdrawalId: 'w-1' })).toBe(false);
    // No amount on the wire: the ledger is the record of value.
    expect(ok({ amount: '12' })).toBe(false);
  });

  it('names both missing ends until svc-pay publishes it and a notice subscribes', () => {
    expect(wiringSocketReason('payWithdrawalStatusUpdated', 'publisher')).toMatch(/svc-pay/);
    expect(wiringSocketReason('payWithdrawalStatusUpdated', 'subscriber')).toMatch(/svc-notify/);
  });
});
