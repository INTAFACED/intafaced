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

/**
 * A held withdrawal whose chain transaction an operator dropped and the chain showed dropped (W-custody-ops-12). It is stored
 * as `failed` with this code after its hold was reversed once, under the attempt's own key.
 */
export const WITHDRAWAL_DROPPED_CODE = 'custody.dropped_by_chain';

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
 * client reference. `held -> canceled` is W-withdraw-07: only when the dispatch journal proves nothing was sent
 * (`isCancellable`). W-withdraw-10 and -11 add moves here.
 */
const TRANSITIONS: Record<WithdrawalStatus, readonly WithdrawalStatus[]> = {
  requested: ['pending_review', 'approved', 'rejected', 'canceled'],
  pending_review: ['approved', 'rejected', 'canceled', 'needs_review'],
  approved: ['held', 'rejected', 'canceled'],
  held: ['dispatching', 'settled', 'failed', 'canceled'],
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

/**
 * The stored moves of an internal withdrawal (W-withdraw-14). It is never `held`: svc-bank's one send takes the money from
 * the sender's balance and gives it to the receiver in a single post, so `pending -> sent` collapses `requested -> approved
 * -> held -> settled`, and a send svc-bank proved it never posted collapses `requested -> approved -> held -> failed`. Every
 * other move is the ordinary one.
 */
export function assertStoredInternalTransition(from: StoredWithdrawalStatus, to: StoredWithdrawalStatus): void {
  if (from === 'pending' && (to === 'sent' || to === 'failed')) return;
  assertStoredTransition(from, to);
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

/** The outcome of a withdrawal's current attempt in `pay.withdrawal_rail_attempts`, or `null` when none is journalled. */
export type DispatchJournal = 'requested' | 'accepted' | 'confirming' | 'refused' | null;

/**
 * The journal outcome as the reads see it: a send the rail accepted whose chain depth was read above zero but below the
 * owner's minimum is `confirming` (W-withdraw-06). Depth zero, or not read, stays `accepted`. Every read that shows a row
 * (`getWithdrawal`, `listWithdrawals`, the history and its filter) selects the same expression,
 * `CASE WHEN a.outcome = 'accepted' AND a.confirmations > 0 THEN 'confirming' ELSE a.outcome END`, so they draw one split.
 */

/**
 * What the customer sees for one row (W-withdraw-07). A stored `held` row is split by its current attempt's journal
 * (`HELD_SHOWN`). `journal` undefined means the caller did not read it: `held`.
 */
export function shownStatus(stored: string, failureCode: string | null, journal?: DispatchJournal): WithdrawalStatus {
  const status = customerStatus(stored, failureCode);
  if (status !== 'held' || journal === undefined) return status;
  return HELD_SHOWN[journal ?? 'none'];
}

/** A row's journal outcome as a filter reads it: `none` when its current attempt has no journal row. */
export type JournalFilter = 'none' | Exclude<DispatchJournal, null>;

/**
 * What a stored `held` row shows, by its current attempt's journal outcome. Nothing journalled is `held` (the hold is booked
 * and nothing was asked of the rail), `requested` is `dispatching` (a send was asked for and its outcome is not known),
 * `accepted` is `broadcast` (it left), and an accepted send seen at some depth below the minimum is `confirming`. A journalled refusal is still being put back, so it reads `held` until the row turns
 * `failed`. `shownStatus` reads it and `shownFilterFor` inverts it, so the page and the filter draw one split.
 */
const HELD_SHOWN: Record<JournalFilter, WithdrawalStatus> = {
  none: 'held',
  requested: 'dispatching',
  accepted: 'broadcast',
  confirming: 'confirming',
  refused: 'held',
};

/**
 * What a customer-vocabulary status filter matches, the same split `shownStatus` draws: the stored values, and for a `held`
 * row the journal outcomes of its current attempt (`null`: any). A status no stored value can mean yet matches nothing (an
 * empty `stored`), so a filter on it returns an empty page and never a wrong row.
 */
export function shownFilterFor(status: WithdrawalStatus): { stored: StoredWithdrawalStatus[]; journal: JournalFilter[] | null } {
  const journal = (Object.keys(HELD_SHOWN) as JournalFilter[]).filter((outcome) => HELD_SHOWN[outcome] === status);
  if (journal.length > 0) return { stored: ['held'], journal };
  return { stored: storedStatusesFor(status), journal: null };
}

/**
 * Whether `cancelWithdrawal` would cancel this row. A `requested` row with no send on record can be cancelled. A `held` row
 * only when the journal proves nothing was sent: it moved into `held` under the journalling code (`dispatchJournaled`) and
 * its current attempt has no journal row. Unknown means no.
 */
export function isCancellable(
  stored: string,
  failureCode: string | null,
  journal: DispatchJournal | undefined,
  dispatchJournaled: boolean | null | undefined,
): boolean {
  if (journal !== null) return false;
  if (stored === 'pending') return true;
  // A cancel that wrote its intent on the held row and stopped resumes; any other code on a held row is a refusal being put back.
  return stored === 'held' && dispatchJournaled === true && (failureCode === null || failureCode === WITHDRAWAL_CANCELED_CODE);
}
