import { describe, expect, it } from 'vitest';
import {
  WITHDRAWAL_CANCELED_CODE,
  WITHDRAWAL_STATUSES,
  WithdrawalStateError,
  assertStoredTransition,
  assertTransition,
  broadcastPossible,
  customerStatus,
  isCancellable,
  isLegalTransition,
  isTerminal,
  mayReleaseHold,
  shownStatus,
  shownFilterFor,
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
  ['held', 'canceled'],
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

  it('filters a held row the way shownStatus splits it: by its current attempt’s journal', () => {
    expect(shownFilterFor('held')).toEqual({ stored: ['held'], journal: ['none', 'refused'] });
    expect(shownFilterFor('dispatching')).toEqual({ stored: ['held'], journal: ['requested'] });
    expect(shownFilterFor('broadcast')).toEqual({ stored: ['held'], journal: ['accepted'] });
    expect(shownFilterFor('settled')).toEqual({ stored: ['sent'], journal: null });
    // W-withdraw-06: an accepted send the chain holds below the minimum depth reads its own journal value.
    expect(shownFilterFor('confirming')).toEqual({ stored: ['held'], journal: ['confirming'] });
    expect(shownFilterFor('needs_review')).toEqual({ stored: [], journal: null });
  });

  it('shows an accepted send seen below the minimum depth as confirming, and depth zero as broadcast', () => {
    expect(shownStatus('held', null, 'confirming')).toBe('confirming');
    expect(shownStatus('held', null, 'accepted')).toBe('broadcast');
    expect(shownStatus('sent', null, 'confirming')).toBe('settled');
    expect(isCancellable('held', null, 'confirming', true)).toBe(false);
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

describe('what the customer sees, and whether a cancel would run (W-withdraw-07)', () => {
  it('splits a held row by its current attempt in the dispatch journal', () => {
    expect(shownStatus('held', null, null)).toBe('held');
    expect(shownStatus('held', null, 'requested')).toBe('dispatching');
    expect(shownStatus('held', null, 'accepted')).toBe('broadcast');
    expect(shownStatus('held', 'rail.refused', 'refused')).toBe('held');
    expect(shownStatus('held', null)).toBe('held');
    expect(shownStatus('pending', null, null)).toBe('requested');
    expect(shownStatus('sent', null, 'accepted')).toBe('settled');
    expect(shownStatus('failed', WITHDRAWAL_CANCELED_CODE, null)).toBe('canceled');
  });

  it('cancels a requested row with no send on record, and a held row only when the journal proves nothing was sent', () => {
    expect(isCancellable('pending', null, null, null)).toBe(true);
    expect(isCancellable('pending', WITHDRAWAL_CANCELED_CODE, null, null)).toBe(true);
    expect(isCancellable('pending', null, 'requested', null)).toBe(false);
    expect(isCancellable('held', null, null, true)).toBe(true);
    expect(isCancellable('held', WITHDRAWAL_CANCELED_CODE, null, true)).toBe(true);
    // Held before the journal marker existed: dispatch unknown.
    expect(isCancellable('held', null, null, null)).toBe(false);
    expect(isCancellable('held', null, 'requested', true)).toBe(false);
    expect(isCancellable('held', null, 'accepted', true)).toBe(false);
    expect(isCancellable('held', 'rail.refused', 'refused', true)).toBe(false);
    // The journal was not read: unknown is no.
    expect(isCancellable('held', null, undefined, true)).toBe(false);
    expect(isCancellable('pending', null, undefined, null)).toBe(false);
    for (const stored of ['sent', 'failed']) expect(isCancellable(stored, null, null, true)).toBe(false);
  });
});
