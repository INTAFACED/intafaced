import type { Amount } from '../money.js';
import type { AccountRef, EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError, isValidOwnerId } from '../types.js';
import { houseFees } from '../accounts.js';
import { ownFundsPlaceAccount, type OwnFundsPlace } from './own-funds.js';

/**
 * A PAID ACADEMY COURSE, BOUGHT FROM THE BUYER'S OWN WALLET, AND ITS STAFF REFUND (J-academy-07; launch money model, rule 1).
 *
 * At launch INTAFACED holds no customer money, so the buyer pays from their own wallet and the payment lands at one of
 * INTAFACED's own-funds places. Only once that payment is confirmed on chain does svc-academy post the purchase:
 *
 *   purchase  `fees:academy` ← our own-funds place      (keyed `academy:purchase:<course>:<userId>:<n>`)
 *   refund    our own-funds place ← `fees:academy`      (keyed `academy:refund:<course>:<userId>:<n>`)
 *
 * The purchase puts our academy revenue up and records the money now ours at the place (a `treasury` place goes further
 * below zero). The refund is its exact reverse, keyed on the same purchase, so one purchase is refunded at most once.
 *
 * Both legs are INTAFACED's own accounts (`house` revenue and an own-funds place), so neither recipe moves a customer
 * balance, neither is in `customerBalanceRecipes`, and the custody guard needs no change. `n` is the buyer's n-th purchase
 * of that course, so a buyer who was refunded can buy the same course again under a new key.
 *
 * Refusals:
 * - A refund above what the place holds of ours is refused by the ledger (`balanceAllowed`, `ledger.insufficient_funds`),
 *   and so is a refund above the academy revenue on the book.
 * - Every input is checked here: course id, buyer id, purchase number, asset, amount, the chain transaction hash, and the
 *   key length.
 *
 * What these recipes cannot check, because a recipe does not read the outside world: that the named transaction really
 * paid that amount to that place. The caller reads it from the chain before it posts.
 */
export const ACADEMY_PURCHASE_MODULE = 'academy';

const KEY_MAX = 200;
const COURSE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CHAIN_TX = /^0x[0-9a-f]{64}$/;

function requireCourse(course: unknown): string {
  if (typeof course !== 'string' || !COURSE_ID.test(course)) {
    throw new InvalidEntryError('course must be a lower-case course id: letters, digits and dashes, at most 64 characters');
  }
  return course;
}

function requireUser(userId: unknown): string {
  if (typeof userId !== 'string' || !isValidOwnerId('user', userId)) {
    throw new InvalidEntryError("userId must be the buyer's id as stored (a lowercase UUID)");
  }
  return userId;
}

function requireN(n: unknown): bigint {
  if (typeof n !== 'bigint' || n < 1n) throw new InvalidEntryError('n must be a whole number, at least one');
  return n;
}

function requireAsset(assetId: unknown): string {
  if (typeof assetId !== 'string' || !assetId.trim() || assetId.trim() !== assetId) {
    throw new InvalidEntryError('assetId is required, with no surrounding spaces');
  }
  return assetId;
}

function requireAmount(amount: unknown): Amount {
  if (typeof amount !== 'bigint' || amount <= 0n) throw new InvalidEntryError('an academy purchase amount must be above zero');
  return amount;
}

function requirePaymentId(paymentId: unknown): string {
  if (typeof paymentId !== 'string' || !CHAIN_TX.test(paymentId)) {
    throw new InvalidEntryError('paymentId must be the chain transaction hash: lowercase 0x and 64 hex characters');
  }
  return paymentId;
}

function requireKey(key: string): string {
  if (key.length > KEY_MAX) throw new InvalidEntryError(`the post key would be longer than ${KEY_MAX} characters`);
  return key;
}

const debit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'debit', amount });
const credit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'credit', amount });

/** The key of the buyer's n-th purchase of a course: the journey's acceptance wording. */
export function academyPurchaseKey(course: string, userId: string, n: bigint): string {
  return `academy:purchase:${course}:${userId}:${n}`;
}

/** The key of the refund of the buyer's n-th purchase of a course. */
export function academyRefundKey(course: string, userId: string, n: bigint): string {
  return `academy:refund:${course}:${userId}:${n}`;
}

export interface AcademyPurchaseInput {
  /** The course id. */
  readonly course: string;
  /** The buyer. Named in the key and meta, never a balance of theirs. */
  readonly userId: string;
  /** The buyer's n-th purchase of this course, from one. */
  readonly n: bigint;
  readonly assetId: string;
  readonly amount: Amount;
  /** Where the buyer's payment arrived: one of our own-funds places. */
  readonly to: OwnFundsPlace;
  /** The chain transaction hash of the buyer's payment. */
  readonly paymentId: string;
}

/** A paid course bought from the buyer's own wallet: academy revenue up, more of ours at the place. */
export function academyPurchase(input: AcademyPurchaseInput): PostRequest {
  const course = requireCourse(input.course);
  const userId = requireUser(input.userId);
  const n = requireN(input.n);
  const assetId = requireAsset(input.assetId);
  const amount = requireAmount(input.amount);
  const paymentId = requirePaymentId(input.paymentId);
  const place = ownFundsPlaceAccount(input.to, assetId);
  return {
    idempotencyKey: requireKey(academyPurchaseKey(course, userId, n)),
    module: ACADEMY_PURCHASE_MODULE,
    reason: 'academy.purchase.posted',
    meta: { course, userId, paymentId, to: place.ownerId },
    entries: [debit(houseFees(ACADEMY_PURCHASE_MODULE, assetId), amount), credit(place, amount)],
  };
}

export interface AcademyPurchaseRefundInput {
  readonly course: string;
  readonly userId: string;
  /** The number of the purchase being refunded. */
  readonly n: bigint;
  readonly assetId: string;
  readonly amount: Amount;
  /** The own-funds place the refund is paid from. */
  readonly from: OwnFundsPlace;
  /** The chain transaction hash of the refund paid to the buyer's wallet. */
  readonly paymentId: string;
}

/** A staff refund of one purchase: the exact reverse of `academyPurchase`, keyed on that purchase. */
export function academyPurchaseRefund(input: AcademyPurchaseRefundInput): PostRequest {
  const course = requireCourse(input.course);
  const userId = requireUser(input.userId);
  const n = requireN(input.n);
  const assetId = requireAsset(input.assetId);
  const amount = requireAmount(input.amount);
  const paymentId = requirePaymentId(input.paymentId);
  const place = ownFundsPlaceAccount(input.from, assetId);
  return {
    idempotencyKey: requireKey(academyRefundKey(course, userId, n)),
    module: ACADEMY_PURCHASE_MODULE,
    reason: 'academy.purchase.refunded',
    meta: { course, userId, purchaseKey: academyPurchaseKey(course, userId, n), paymentId, from: place.ownerId },
    // Revenue comes back down (refused below zero); the place comes back toward zero (refused above what it holds of ours).
    entries: [credit(houseFees(ACADEMY_PURCHASE_MODULE, assetId), amount), debit(place, amount)],
  };
}
