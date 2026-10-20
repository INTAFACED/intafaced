import { describe, expect, it } from 'vitest';
import {
  WITHDRAWAL_CANCELED_CODE,
  WITHDRAWAL_STATUSES,
  WithdrawalStateError,
  assertStoredTransition,
  assertTransition,
  broadcastPossible,
  customerStatus,
  isLegalTransition,
  isTerminal,
  mayReleaseHold,
  storedStatusesFor,
  type WithdrawalStatus,
} from './status.js';

/** Every legal move, written out. Anything not here must throw. */
const LEGAL: ReadonlyArray<readonly [WithdrawalStatus, WithdrawalStatus]> = [
  ['requested', 'pending_review'],
  ['requested', 'approved'],
  ['requested', 'rejected'],
  ['requested', 'canceled'],
  ['pending_review', 'approved'],
  ['pending_review', 'rejected'],
  ['pending_review', 'canceled'],
  ['pending_review', 'needs_review'],
  ['approved', 'held'],
  ['approved', 'rejected'],
  ['approved', 'canceled'],
  ['held', 'dispatching'],
  ['held', 'settled'],
  ['held', 'failed'],
  ['dispatching', 'broadcast'],
  ['dispatching', 'failed'],
  ['dispatching', 'needs_review'],
  ['broadcast', 'confirming'],
  ['broadcast', 'needs_review'],
  ['confirming', 'settled'],
  ['confirming', 'needs_review'],
  ['needs_review', 'pending_review'],
  ['needs_review', 'settled'],
  ['needs_review', 'failed'],
  ['failed', 'requested'],
];

describe('withdrawal transition table', () => {
  it('accepts every legal move and refuses every other pair, by name', () => {
    const legal = new Set(LEGAL.map(([a, b]) => `${a}>${b}`));
    let refused = 0;
    for (const from of WITHDRAWAL_STATUSES) {
      for (const to of WITHDRAWAL_STATUSES) {
        if (legal.has(`${from}>${to}`)) {
          expect(isLegalTransition(from, to)).toBe(true);
          expect(() => assertTransition(from, to)).not.toThrow();
        } else {
          refused += 1;
          expect(isLegalTransition(from, to)).toBe(false);
          expect(() => assertTransition(from, to)).toThrow(WithdrawalStateError);
          try {
            assertTransition(from, to);
          } catch (error) {
            expect((error as WithdrawalStateError).code).toBe('wallet.withdrawal_transition_refused');
          }
        }
      }
    }
    expect(refused).toBe(WITHDRAWAL_STATUSES.length ** 2 - LEGAL.length);
  });

  it('has no way out of settled, rejected or canceled', () => {
    for (const status of ['settled', 'rejected', 'canceled'] as const) {
      expect(isTerminal(status)).toBe(true);
    }
    for (const status of ['requested', 'held', 'failed', 'needs_review'] as const) expect(isTerminal(status)).toBe(false);
  });

  it('never lets a hold be released once a transaction may have left', () => {
    for (const status of ['dispatching', 'broadcast', 'confirming', 'needs_review', 'settled'] as const) {
      expect(broadcastPossible(status)).toBe(true);
      expect(mayReleaseHold(status)).toBe(false);
    }
    for (const status of ['requested', 'pending_review', 'approved', 'held', 'rejected', 'canceled', 'failed'] as const) {
      expect(mayReleaseHold(status)).toBe(true);
    }
    // After a broadcast the only way to `failed` goes through review.
    expect(isLegalTransition('broadcast', 'failed')).toBe(false);
    expect(isLegalTransition('confirming', 'failed')).toBe(false);
    expect(isLegalTransition('needs_review', 'failed')).toBe(true);
  });
});

describe('the stored values', () => {
  it('reads an old row in the customer vocabulary without rewriting it', () => {
    expect(customerStatus('pending')).toBe('requested');
    expect(customerStatus('held')).toBe('held');
    expect(customerStatus('sent')).toBe('settled');
    expect(customerStatus('failed')).toBe('failed');
  });

  it('refuses a stored value it does not know instead of inventing a status', () => {
    expect(() => customerStatus('mystery')).toThrow(/Unknown stored withdrawal status/);
  });

  it('maps a filter back to the stored values, and to none for a status nothing stores yet', () => {
    expect(storedStatusesFor('settled')).toEqual(['sent']);
    expect(storedStatusesFor('requested')).toEqual(['pending']);
    // A cancelled row is a failed row with the cancel code, so the filter adds the code on top of this.
    expect(storedStatusesFor('canceled')).toEqual(['failed']);
    expect(storedStatusesFor('broadcast')).toEqual([]);
    expect(customerStatus('failed', WITHDRAWAL_CANCELED_CODE)).toBe('canceled');
    expect(customerStatus('failed', 'rail.refused')).toBe('failed');
    expect(customerStatus('pending', WITHDRAWAL_CANCELED_CODE)).toBe('requested');
  });

  it('allows exactly the four moves the code writes today', () => {
    expect(() => assertStoredTransition('pending', 'held')).not.toThrow();
    expect(() => assertStoredTransition('held', 'sent')).not.toThrow();
    expect(() => assertStoredTransition('held', 'failed')).not.toThrow();
    expect(() => assertStoredTransition('failed', 'pending')).not.toThrow();
    for (const [a, b] of [
      ['sent', 'held'],
      ['sent', 'failed'],
      ['sent', 'pending'],
      ['failed', 'held'],
      ['failed', 'sent'],
      ['pending', 'sent'],
      ['pending', 'failed'],
      ['held', 'pending'],
    ] as const) {
      expect(() => assertStoredTransition(a, b)).toThrow(WithdrawalStateError);
    }
  });
});
