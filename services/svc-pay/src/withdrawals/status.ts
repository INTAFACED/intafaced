export type WithdrawalStateErrorCode = 'wallet.withdrawal_transition_refused' | 'wallet.withdrawal_status_unknown';

/** A refused move or an unreadable stored value. Both are bugs in the caller, never user input, so they are not mapped to a client code. */
export class WithdrawalStateError extends Error {
  constructor(
    message: string,
    readonly code: WithdrawalStateErrorCode,
  ) {
    super(message);
    this.name = 'WithdrawalStateError';
  }
}

/**
 * The withdrawal status vocabulary and its transition table (W-withdraw-06, ENGINE W-1/W-2/W-3).
 *
 * Today `pay.withdrawals.status` stores four values (`pending`, `held`, `sent`, `failed`). The customer-facing
 * vocabulary is wider: every state a withdrawal can be in once review, approval, dispatch and confirmation exist.
 * `customerStatus` shows a stored row in that vocabulary without rewriting it (an old `sent` row reads as `settled`),
 * so no row loses a hold. A move the table does not list THROWS `wallet.withdrawal_transition_refused`; it is never a
 * silent no-op, because a silent no-op hides a double settle.
 */
export const WITHDRAWAL_STATUSES = [
  'requested',
  'pending_review',
  'approved',
  'held',
  'dispatching',
  'broadcast',
  'confirming',
  'settled',
  'rejected',
  'canceled',
  'failed',
  'needs_review',
] as const;
export type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number];

/** The four values the table stores today. */
export type StoredWithdrawalStatus = 'pending' | 'held' | 'sent' | 'failed';

const FROM_STORED: Record<StoredWithdrawalStatus, WithdrawalStatus> = {
  pending: 'requested',
  held: 'held',
  sent: 'settled',
  failed: 'failed',
};

/**
 * A cancelled withdrawal is stored as `failed` with this code: its hold (if any) is already reversed, which is what
 * `failed` means, and the enum has no `canceled` value to add without a migration that cannot be taken back. A retry
 * of the same client reference must not reopen it (`withdraw` refuses with `pay.withdrawal_canceled`).
 */
export const WITHDRAWAL_CANCELED_CODE = 'withdrawal.canceled';

/** A stored row in the customer vocabulary. An unknown stored value is a bug, not a made-up status. */
export function customerStatus(stored: string, failureCode?: string | null): WithdrawalStatus {
  if (stored === 'failed' && failureCode === WITHDRAWAL_CANCELED_CODE) return 'canceled';
  const status = (FROM_STORED as Record<string, WithdrawalStatus | undefined>)[stored];
  if (!status) throw new WithdrawalStateError(`Unknown stored withdrawal status "${stored}"`, 'wallet.withdrawal_status_unknown');
  return status;
}

/**
 * Stored values a customer-vocabulary status matches today. A status no stored value can mean yet matches nothing
 * (an empty list), so a filter on it returns an empty page and never a wrong row.
 */
export function storedStatusesFor(status: WithdrawalStatus): StoredWithdrawalStatus[] {
  // A cancelled row is a `failed` row with the cancel code; the caller adds that code to the filter.
  if (status === 'canceled') return ['failed'];
  return (Object.entries(FROM_STORED) as Array<[StoredWithdrawalStatus, WithdrawalStatus]>).filter(([, v]) => v === status).map(([k]) => k);
}

/**
 * The legal moves. `pending_review` holds a withdrawal for limits, screening, travel rule or approval. The hold is
 * posted on the move into `held`, so `canceled` or `rejected` before `held` releases nothing. A failure after
 * `broadcast` is not a plain `failed`: it goes through `needs_review` and is final only when an operator or the
 * reconciler proves it (ENGINE W-3). `held -> settled` is the rail with final acceptance (ENGINE W-4); a chain
 * withdrawal goes through `dispatching`, `broadcast` and `confirming`. `failed -> requested` is the retry of the same
 * client reference. W-withdraw-07, -10 and -11 add moves here.
 */
const TRANSITIONS: Record<WithdrawalStatus, readonly WithdrawalStatus[]> = {
  requested: ['pending_review', 'approved', 'rejected', 'canceled'],
  pending_review: ['approved', 'rejected', 'canceled', 'needs_review'],
  approved: ['held', 'rejected', 'canceled'],
  held: ['dispatching', 'settled', 'failed'],
  dispatching: ['broadcast', 'failed', 'needs_review'],
  broadcast: ['confirming', 'needs_review'],
  confirming: ['settled', 'needs_review'],
  needs_review: ['pending_review', 'settled', 'failed'],
  failed: ['requested'],
  settled: [],
  rejected: [],
  canceled: [],
};

export function isLegalTransition(from: WithdrawalStatus, to: WithdrawalStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function legalTransitionsFrom(from: WithdrawalStatus): readonly WithdrawalStatus[] {
  return TRANSITIONS[from];
}

/** Throws `wallet.withdrawal_transition_refused`. Call it BEFORE posting anything for the move. */
export function assertTransition(from: WithdrawalStatus, to: WithdrawalStatus): void {
  if (!isLegalTransition(from, to)) {
    throw new WithdrawalStateError(`A withdrawal cannot move from ${from} to ${to}`, 'wallet.withdrawal_transition_refused');
  }
}

/** The same check for the four stored values, for the code that still writes them. */
export function assertStoredTransition(from: StoredWithdrawalStatus, to: StoredWithdrawalStatus): void {
  // The stored `pending -> held` collapses `requested -> approved -> held`: review and approval do not exist as
  // stored states yet, so the hold is the first thing written.
  if (from === 'pending' && to === 'held') return;
  assertTransition(customerStatus(from), customerStatus(to));
}

/** True once a transaction may have left: the hold must never be released from these states (ENGINE W-3). */
export function broadcastPossible(status: WithdrawalStatus): boolean {
  return status === 'dispatching' || status === 'broadcast' || status === 'confirming' || status === 'needs_review' || status === 'settled';
}

/** The hold may be released only where no broadcast can have happened. */
export function mayReleaseHold(status: WithdrawalStatus): boolean {
  return !broadcastPossible(status);
}

/** Final: nothing moves out of it. */
export function isTerminal(status: WithdrawalStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
