import type { Amount } from '../money.js';
import type { AccountRef, EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError } from '../types.js';
import { moduleAccount, userAvailable, userHold } from '../accounts.js';

/**
 * STAFF HOLDS ON FUNDS (ops ENGINE LC-8, LC-9; slice OPS-accounts-desk-01; ADR 2026-10-22 service-access-calls 3.7).
 *
 * A staff hold reserves part of one customer's balance in a pot of its own per
 * hold (`ops:hold:<holdNo>`), owned by that customer. Available falls, total
 * does not. svc-ops owns the hold row, its state and the second approver; these
 * recipes only fix the shape of each post.
 *
 *   place    customer available → customer hold `ops:hold:<holdNo>`
 *   release  customer hold      → customer available    (in part or in full; staff with an approver, or the expiry worker)
 *   confirm  customer hold      → `ops:hold-confirm:<slug>` (the whole remainder, once)
 *
 * Place and release move value only between the same customer's available and
 * held balances. Confirm moves held value only into the `ops:hold-confirm:`
 * namespace. Which slug is the owner's setting in svc-ops (blank refuses
 * `owner.decision` there and nothing posts); the recipe cannot know it, so it
 * confines the destination to that namespace, and the worst a caller can do
 * with these recipes is move a held amount there, where reconciliation and the
 * hold's audit trail show it. Moving confirmed value on, or undoing a confirm,
 * is an operator reversal (OPS-ledger-desk-02), not one of these recipes.
 *
 * The ledger's non-negative hold balance caps releases plus confirms at the
 * placed amount. `holdNo` is svc-ops' one global hold sequence (not per
 * customer or asset), so a key names exactly one hold. Release and attempt
 * numbers are stored before the call: a retry reuses the stored number, and a
 * failed key is never reused.
 */

const debit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'debit', amount });
const credit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'credit', amount });

/** A stored sequence number: a positive decimal integer, so `:` can never reach a key. */
const SEQUENCE_PATTERN = /^[1-9][0-9]*$/;
/** The owner-named confirm account's slug: lowercase letters, digits and dashes. */
const CONFIRM_ACCOUNT_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

function requireText(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new InvalidEntryError(`${name} is required for a staff hold`);
  return value.trim();
}

function requireSequence(name: string, value: unknown): string {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !SEQUENCE_PATTERN.test(text)) {
    throw new InvalidEntryError(`${name} must be a positive integer from a stored sequence`);
  }
  return text;
}

function requirePositive(name: string, value: Amount): void {
  if (typeof value !== 'bigint' || value <= 0n) throw new InvalidEntryError(`${name} must be positive`);
}

/** The customer's pot for one staff hold. */
export function staffHoldAccount(userId: string, assetId: string, holdNo: string | number): AccountRef {
  return userHold(userId, assetId, `ops:hold:${requireSequence('holdNo', holdNo)}`);
}

/** The owner-named account a confirmed staff hold moves to. */
export function staffHoldConfirmAccount(confirmAccount: string, assetId: string): AccountRef {
  if (typeof confirmAccount !== 'string' || !CONFIRM_ACCOUNT_PATTERN.test(confirmAccount)) {
    throw new InvalidEntryError('confirmAccount must be the owner-named slug (lowercase letters, digits and dashes)');
  }
  return moduleAccount('ops', `hold-confirm:${confirmAccount}`, assetId);
}

export interface StaffHoldInput {
  /** svc-ops' stored hold number. */
  holdNo: string | number;
  /** The customer whose funds are held. */
  userId: string;
  assetId: string;
  amount: Amount;
}

/**
 * Who lifted (part of) a hold: a staff release with its second approver, or the
 * expiry worker (LC-9) with the stored expiry it acted on, so the ledger record
 * shows which rule let a release through without an approver.
 */
export type StaffHoldReleaseCause =
  { readonly kind: 'approval'; readonly approvalId: string } | { readonly kind: 'expiry'; readonly expiresAt: string };

export interface StaffHoldReleaseInput extends StaffHoldInput {
  /** svc-ops' stored release number, allocated once before the call; a retry reuses it. */
  releaseNo: string | number;
  cause: StaffHoldReleaseCause;
}

export interface StaffHoldConfirmInput extends StaffHoldInput {
  /** What svc-ops' locked hold row says is still held. A confirm moves all of it: `amount` must equal it. */
  heldRemaining: Amount;
  /** Attempt ordinal: a confirm retried after a definite failure takes the next one. */
  attempt: string | number;
  /** The identity action approval of the second staff member; carried for audit only. */
  approvalId: string;
  /** The owner-named account slug (`ops:hold-confirm:<slug>`). */
  confirmAccount: string;
}

function pots(input: StaffHoldInput) {
  const holdNo = requireSequence('holdNo', input.holdNo);
  const userId = requireText('userId', input.userId);
  const assetId = requireText('assetId', input.assetId);
  return { holdNo, userId, assetId, hold: staffHoldAccount(userId, assetId, holdNo), available: userAvailable(userId, assetId) };
}

/** A stored expiry instant, ISO 8601 in UTC (`2026-10-24T15:00:00Z` or with milliseconds). */
const EXPIRY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

function releaseCause(
  cause: StaffHoldReleaseCause | undefined,
): { cause: 'approval'; approvalId: string } | { cause: 'expiry'; expiresAt: string } {
  if (cause?.kind === 'expiry') {
    if (typeof cause.expiresAt !== 'string' || !EXPIRY_PATTERN.test(cause.expiresAt)) {
      throw new InvalidEntryError('an expiry release carries the stored expiry instant (ISO 8601, UTC)');
    }
    return { cause: 'expiry', expiresAt: cause.expiresAt };
  }
  if (cause?.kind === 'approval') return { cause: 'approval', approvalId: requireText('approvalId', cause.approvalId) };
  throw new InvalidEntryError('a staff hold release names its cause: a second approver or the expiry worker');
}

/** Place a hold: customer available → customer hold `ops:hold:<holdNo>`. */
export function staffHoldPlace(input: StaffHoldInput): PostRequest {
  requirePositive('staff hold amount', input.amount);
  const p = pots(input);
  return {
    idempotencyKey: `ops:hold:${p.holdNo}`,
    module: 'ops',
    reason: 'ops.hold.placed',
    meta: { holdNo: p.holdNo },
    entries: [credit(p.available, input.amount), debit(p.hold, input.amount)],
  };
}

/** Release part or all of a hold: customer hold → customer available. */
export function staffHoldRelease(input: StaffHoldReleaseInput): PostRequest {
  requirePositive('staff hold release amount', input.amount);
  const p = pots(input);
  const releaseNo = requireSequence('releaseNo', input.releaseNo);
  return {
    idempotencyKey: `ops:hold-release:${p.holdNo}:${releaseNo}`,
    module: 'ops',
    reason: 'ops.hold.released',
    meta: { holdNo: p.holdNo, releaseNo, ...releaseCause(input.cause) },
    entries: [credit(p.hold, input.amount), debit(p.available, input.amount)],
  };
}

/** A confirm moves the whole remainder of a hold, never a piece of it. */
export class StaffHoldPartialConfirmError extends InvalidEntryError {
  constructor() {
    super('ops.hold_amount_exceeds_remaining: a staff hold confirm moves exactly what is still held');
    this.name = 'StaffHoldPartialConfirmError';
  }
}

/** Confirm what is left of a hold: customer hold → the owner-named `ops:hold-confirm:` account. */
export function staffHoldConfirm(input: StaffHoldConfirmInput): PostRequest {
  requirePositive('staff hold confirm amount', input.amount);
  requirePositive('held remaining', input.heldRemaining);
  if (input.amount !== input.heldRemaining) throw new StaffHoldPartialConfirmError();
  const p = pots(input);
  const attempt = requireSequence('attempt', input.attempt);
  const approvalId = requireText('approvalId', input.approvalId);
  const destination = staffHoldConfirmAccount(input.confirmAccount, p.assetId);
  return {
    idempotencyKey: `ops:hold-confirm:${p.holdNo}:${attempt}`,
    module: 'ops',
    reason: 'ops.hold.confirmed',
    meta: { holdNo: p.holdNo, attempt, approvalId, confirmAccount: input.confirmAccount },
    entries: [credit(p.hold, input.amount), debit(destination, input.amount)],
  };
}
