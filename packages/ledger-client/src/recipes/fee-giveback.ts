import type { Amount } from '../money.js';
import { formatAmount } from '../money.js';
import type { AccountRef, EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError, LedgerError, isValidOwnerId } from '../types.js';
import { houseFees, moduleAccount } from '../accounts.js';
import { BUILDER_FEE_POT, earnedBuilderFeeKey } from './builder-fee.js';
import { ownFundsPlaceAccount, type OwnFundsPlace } from './own-funds.js';

/**
 * GIVE A CUSTOMER BACK THE FEE THEY PAID ON A FILL, FROM OUR OWN FUNDS TO THEIR OWN WALLET (launch money model; project-state
 * OWNER.md item 288, `b1` change 2: "Give a fee back | Income → what we owe → paying wallet, linked to the fill's entry |
 * `fee-refund:<the fill's earn key>`"; question 2: "yes, as goodwill, with two approvers, up to the fee that customer paid
 * on that fill").
 *
 * The venue never refunds a builder fee: a fill is final. A give-back is our own money leaving, so it is our liability to
 * that customer until we pay it from one of our own-funds places to their own wallet:
 *
 *   owe   builder-fee revenue                  → `trade:fee-giveback-owed:<userId>`  (keyed `fee-refund:<the fill's earn key>`)
 *   pay   `trade:fee-giveback-owed:<userId>`   → our own-funds place                  (keyed by the chain transaction)
 *
 * The key names the fill's Earn entry, so one fill is given back at most once, and the cap below is the whole cap.
 *
 * What these recipes cannot check, because a recipe does not read the book: that the fill's Earn entry was posted and
 * `feePaid` is its amount, and that the two approvers are operators allowed to approve. The first production caller checks
 * both before it posts, and carries the grant.
 *
 * Every leg is one of INTAFACED's own accounts (`house`, `module`, or an own-funds `treasury` place), so neither recipe moves
 * a customer balance, neither is in `customerBalanceRecipes`, and the custody guard needs no change.
 *
 * Refusals:
 * - Owe is refused without two approvers, or with the same approver twice (`ledger.fee_giveback_approvers`).
 * - Owe is refused above the fee that customer paid on that fill (`ledger.fee_giveback_exceeded`).
 * - Owe is refused when builder-fee revenue holds less than the amount (`ledger.insufficient_funds`, house account).
 * - Pay is refused when the book shows less than the amount at the paying place (`balanceAllowed`,
 *   `ledger.insufficient_funds`), and above what we owe that customer (module account).
 */
const MODULE = 'trade';
const KEY_MAX = 200;

const VENUE_ID = /^[a-z0-9][a-z0-9_-]*$/;
/** A venue's own id for an account or a fill, as `builderFeeEarn` takes it: no spaces, no `:`. */
const VENUE_REF = /^[^\s:]+$/;
/** An approver's staff id as stored: no spaces, no `:`. */
const STAFF_REF = /^[^\s:]+$/;
/** A chain transaction hash: no spaces, no `:`. */
const CHAIN_TX = /^[A-Za-z0-9_-]+$/;
const WALLET_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const FEE_GIVEBACK_APPROVERS_CODE = 'ledger.fee_giveback_approvers';
export const FEE_GIVEBACK_EXCEEDED_CODE = 'ledger.fee_giveback_exceeded';

/** Refused: a give-back needs two approvers, and they must be two different people. */
export class FeeGiveBackApproversError extends LedgerError {
  constructor(readonly why: 'missing' | 'same') {
    super(
      why === 'same'
        ? 'A fee give-back needs two different approvers; the same approver cannot approve it twice.'
        : 'A fee give-back needs two approvers, each named by their staff id.',
      FEE_GIVEBACK_APPROVERS_CODE,
    );
    this.name = 'FeeGiveBackApproversError';
  }
}

/** Refused: the give-back is above the fee that customer paid on that fill. */
export class FeeGiveBackExceededError extends LedgerError {
  constructor(
    readonly feePaid: Amount,
    readonly amount: Amount,
  ) {
    super(
      `Giving back ${formatAmount(amount)} is more than the ${formatAmount(feePaid)} fee the customer paid on that fill.`,
      FEE_GIVEBACK_EXCEEDED_CODE,
    );
    this.name = 'FeeGiveBackExceededError';
  }
}

function requireVenue(venueId: unknown): string {
  if (typeof venueId !== 'string' || !VENUE_ID.test(venueId)) throw new InvalidEntryError('venueId must be a lower-case venue id');
  return venueId;
}

function requireVenueRef(name: string, value: unknown): string {
  if (typeof value !== 'string' || !VENUE_REF.test(value))
    throw new InvalidEntryError(`${name} must be the venue's own id, with no spaces or colons`);
  return value;
}

function requireUser(userId: unknown): string {
  if (typeof userId !== 'string' || !isValidOwnerId('user', userId)) {
    throw new InvalidEntryError("userId must be the customer's id as stored (a lowercase UUID)");
  }
  return userId;
}

function requireAsset(assetId: unknown): string {
  if (typeof assetId !== 'string' || !assetId.trim() || assetId.trim() !== assetId) {
    throw new InvalidEntryError('assetId is required, with no surrounding spaces');
  }
  return assetId;
}

function requirePositive(name: string, value: unknown): Amount {
  if (typeof value !== 'bigint' || value <= 0n) throw new InvalidEntryError(`${name} must be above zero`);
  return value;
}

function requireApprovers(approvers: unknown): readonly [string, string] {
  if (!Array.isArray(approvers) || approvers.length !== 2) throw new FeeGiveBackApproversError('missing');
  const [a, b] = approvers as unknown[];
  if (typeof a !== 'string' || typeof b !== 'string' || !STAFF_REF.test(a) || !STAFF_REF.test(b)) {
    throw new FeeGiveBackApproversError('missing');
  }
  if (a.toLowerCase() === b.toLowerCase()) throw new FeeGiveBackApproversError('same');
  return [a, b];
}

function requireKey(key: string): string {
  if (key.length > KEY_MAX) throw new InvalidEntryError(`the post key would be longer than ${KEY_MAX} characters`);
  return key;
}

const debit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'debit', amount });
const credit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'credit', amount });

/** What we owe one customer in fees given back, in one asset. */
export function feeGiveBackOwedAccount(userId: string, assetId: string): AccountRef {
  return moduleAccount(MODULE, `fee-giveback-owed:${requireUser(userId)}`, requireAsset(assetId));
}

/** The key of the give-back on one fill: `fee-refund:<the fill's earn key>`, so a fill is given back at most once. */
export function feeGiveBackKey(venueId: string, venueAccount: string, fillId: string): string {
  return `fee-refund:${earnedBuilderFeeKey(venueId, venueAccount, fillId)}`;
}

export interface FeeGiveBackOweInput {
  /** The venue, the venue account and the venue's fill id: the fill's Earn entry (`builderFeeEarn`) this gives back. */
  readonly venueId: string;
  readonly venueAccount: string;
  readonly fillId: string;
  /** The customer who paid the fee on that fill. */
  readonly userId: string;
  readonly assetId: string;
  /** The fee that customer paid on that fill, as its Earn entry recorded it. The give-back is at most this. */
  readonly feePaid: Amount;
  /** What we give back. */
  readonly amount: Amount;
  /** The two operators who approved it, by staff id. Two different people. */
  readonly approvers: readonly [string, string];
}

/** Owe a fee give-back: builder-fee revenue → `trade:fee-giveback-owed:<userId>`. Refused without two approvers or above the fee. */
export function feeGiveBackOwe(input: FeeGiveBackOweInput): PostRequest {
  const venueId = requireVenue(input.venueId);
  const venueAccount = requireVenueRef('venueAccount', input.venueAccount);
  const fillId = requireVenueRef('fillId', input.fillId);
  const userId = requireUser(input.userId);
  const assetId = requireAsset(input.assetId);
  const feePaid = requirePositive('feePaid', input.feePaid);
  const amount = requirePositive('fee give-back amount', input.amount);
  const [approvedBy, secondApprover] = requireApprovers(input.approvers);
  if (amount > feePaid) throw new FeeGiveBackExceededError(feePaid, amount);

  const earnKey = earnedBuilderFeeKey(venueId, venueAccount, fillId);
  return {
    idempotencyKey: requireKey(feeGiveBackKey(venueId, venueAccount, fillId)),
    module: MODULE,
    reason: 'trade.fee_giveback.owed',
    meta: { venueId, earnKey, userId, feePaid: formatAmount(feePaid), approvedBy, secondApprover },
    // Our builder-fee revenue comes down (refused if it holds less); what we owe the customer goes up.
    entries: [credit(houseFees(BUILDER_FEE_POT, assetId), amount), debit(feeGiveBackOwedAccount(userId, assetId), amount)],
  };
}

export interface FeeGiveBackPayOutInput {
  readonly userId: string;
  /** Where we pay from: one of our own-funds places. */
  readonly from: OwnFundsPlace;
  /** The customer's own wallet the chain transaction paid. */
  readonly toWallet: string;
  /** The chain transaction that paid it. */
  readonly chainTx: string;
  readonly assetId: string;
  readonly amount: Amount;
}

/** Pay a fee give-back we owe, from one of our own-funds places to the customer's own wallet: what we owe them → the place. */
export function feeGiveBackPayOut(input: FeeGiveBackPayOutInput): PostRequest {
  const userId = requireUser(input.userId);
  const assetId = requireAsset(input.assetId);
  if (typeof input.chainTx !== 'string' || input.chainTx.length > 128 || !CHAIN_TX.test(input.chainTx)) {
    throw new InvalidEntryError('chainTx must be the chain transaction hash (no spaces or colons, at most 128 characters)');
  }
  if (typeof input.toWallet !== 'string' || !WALLET_ADDRESS.test(input.toWallet)) {
    throw new InvalidEntryError("toWallet must be the customer's own wallet address (0x and 40 hex characters)");
  }
  const amount = requirePositive('fee give-back payment amount', input.amount);
  const place = ownFundsPlaceAccount(input.from, assetId);
  return {
    idempotencyKey: requireKey(`fee-refund:paid:${userId}:${assetId}:${input.chainTx}`),
    module: MODULE,
    reason: 'trade.fee_giveback.paid_out',
    meta: { userId, from: place.ownerId, toWallet: input.toWallet, chainTx: input.chainTx },
    // What we owe comes down; the paying place's balance comes back toward zero (less of ours there). Both are refused by
    // the ledger if they would show less than nothing.
    entries: [credit(feeGiveBackOwedAccount(userId, assetId), amount), debit(place, amount)],
  };
}
