import type { Amount } from '../money.js';
import { formatAmount, mulBps } from '../money.js';
import type { AccountRef, EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError, LedgerError, isValidOwnerId } from '../types.js';
import { houseFees, moduleAccount } from '../accounts.js';
import { BUILDER_FEE_POT, builderFeePayoutKey, earnedBuilderFeeKey } from './builder-fee.js';
import { ownFundsPlaceAccount, type OwnFundsPlace } from './own-funds.js';

/**
 * A SHARE OF OUR FEE WE OWE A LEAD TRADER OR AN AFFILIATE, AND ITS PAYMENT TO THEIR OWN WALLET (launch money model;
 * project-state OWNER.md item 288: we pay lead traders and affiliates at launch).
 *
 * At launch INTAFACED holds no customer money, so a fee share is never credited to a customer balance in our book. It is
 * our liability to that person until we pay it from one of our own-funds places to their own wallet:
 *
 *   fund   builder-fee revenue              → `trade:fee-share-budget:<venueId>`        (keyed by the venue's claim)
 *   owe    `trade:fee-share-budget:<venueId>` → `trade:fee-share-owed:<kind>.<userId>`  (keyed by the fill and the recipient)
 *   pay    `trade:fee-share-owed:…`         → our own-funds place                       (keyed by the chain transaction)
 *
 * What a fee share needs that a reward does not: it is a share of a fee, so
 * - Fund names the venue's claim (`builderFeeReceive`) and Owe draws on the budget, not on revenue, so with nothing set aside
 *   Owe is refused;
 * - it is bounded by the fill it comes from: at most the rate on that fill's fee, and all shares on one fill at most the fee.
 *
 * What these recipes cannot check, because a recipe does not read the book: that the named claim was posted and its amount
 * is right (`houseFees('builder')` also holds fees earned and not collected, so Fund alone does not keep those out), and
 * that `sharedSoFarOnFill` is true. The first production caller must check both against the ledger before it posts.
 *
 * Every leg is one of INTAFACED's own accounts (`house`, `module`, or an own-funds `treasury` place), so none of these
 * recipes moves a customer balance, none is in `customerBalanceRecipes`, and the custody guard needs no change.
 *
 * Refusals:
 * - Fund is refused above the claim it names (`ledger.fee_share_over_claim`), and when builder-fee revenue holds less
 *   (`ledger.insufficient_funds`, house account).
 * - Owe is refused while the share rate is unset (`ledger.fee_share_rate_unset`). The rate is the owner's number; it has no
 *   default (AGENTS.md floor 8).
 * - Owe is refused above the rate on that fill's fee, and when the shares on one fill would pass the fee
 *   (`ledger.fee_share_exceeded`).
 * - Owe is refused when the venue's budget holds less than the amount (`ledger.insufficient_funds`, module account).
 * - Pay is refused when the book shows less than the amount at the paying place (`balanceAllowed`,
 *   `ledger.insufficient_funds`), and above what we owe that recipient (module account).
 */
const MODULE = 'trade';
const KEY_MAX = 200;

const VENUE_ID = /^[a-z0-9][a-z0-9_-]*$/;
/** A venue's own id for an account, a fill or a claim: no spaces, no `:`. */
const VENUE_REF = /^[^\s:]+$/;
/** A chain transaction hash: no spaces, no `:`. */
const CHAIN_TX = /^[A-Za-z0-9_-]+$/;
const WALLET_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_BPS = 10_000;

export const FEE_SHARE_RATE_UNSET_CODE = 'ledger.fee_share_rate_unset';
export const FEE_SHARE_EXCEEDED_CODE = 'ledger.fee_share_exceeded';
export const FEE_SHARE_OVER_CLAIM_CODE = 'ledger.fee_share_over_claim';

/** Refused: the owner has not set the share rate, so no fee share can be owed. */
export class FeeShareRateUnsetError extends LedgerError {
  constructor() {
    super(
      "A fee share cannot be owed while its rate is unset. The rate is the owner's number; it has no default, so every fee " +
        'share is refused until it is set.',
      FEE_SHARE_RATE_UNSET_CODE,
    );
    this.name = 'FeeShareRateUnsetError';
  }
}

/** Refused: this share is above the rate on the fill's fee, or the shares on the fill would pass the fee. */
export class FeeShareExceededError extends LedgerError {
  constructor(
    readonly which: 'rate' | 'fee',
    readonly limit: Amount,
    readonly wouldOwe: Amount,
  ) {
    super(
      `This fee share would owe ${formatAmount(wouldOwe)}, past the ${which === 'rate' ? "rate's share of the fill's fee" : "fill's fee"} ` +
        `of ${formatAmount(limit)}.`,
      FEE_SHARE_EXCEEDED_CODE,
    );
    this.name = 'FeeShareExceededError';
  }
}

/** Refused: more would be set aside than the venue's claim brought in. */
export class FeeShareOverClaimError extends LedgerError {
  constructor(
    readonly claimAmount: Amount,
    readonly amount: Amount,
  ) {
    super(
      `Setting aside ${formatAmount(amount)} for fee shares is more than the ${formatAmount(claimAmount)} this claim collected.`,
      FEE_SHARE_OVER_CLAIM_CODE,
    );
    this.name = 'FeeShareOverClaimError';
  }
}

/** The owner's share rate, in basis points of the fill's fee. `null` or absent means unset, and unset refuses. */
export interface FeeShareRate {
  readonly bps?: number | null;
}

/** The rate as it stands until the owner gives it: unset, so Owe refuses. */
export const FEE_SHARE_RATE_UNSET: FeeShareRate = Object.freeze({ bps: null });

/** Who we owe: a lead trader or an affiliate, by their user id. Carried in the entry, never a balance of theirs. */
export interface FeeShareRecipient {
  readonly kind: 'lead-trader' | 'affiliate';
  readonly userId: string;
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

function requireRecipient(recipient: FeeShareRecipient): FeeShareRecipient {
  if (recipient?.kind !== 'lead-trader' && recipient?.kind !== 'affiliate') {
    throw new InvalidEntryError('recipient.kind must be lead-trader or affiliate');
  }
  if (typeof recipient.userId !== 'string' || !isValidOwnerId('user', recipient.userId)) {
    throw new InvalidEntryError("recipient.userId must be the person's id as stored (a lowercase UUID)");
  }
  return recipient;
}

function requireKey(key: string): string {
  if (key.length > KEY_MAX) throw new InvalidEntryError(`the post key would be longer than ${KEY_MAX} characters`);
  return key;
}

const debit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'debit', amount });
const credit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'credit', amount });

/** Collected builder-fee revenue set aside for one venue's fee shares. */
export function feeShareBudgetAccount(venueId: string, assetId: string): AccountRef {
  return moduleAccount(MODULE, `fee-share-budget:${requireVenue(venueId)}`, requireAsset(assetId));
}

/** What we owe one recipient, in one asset. */
export function feeShareOwedAccount(recipient: FeeShareRecipient, assetId: string): AccountRef {
  const { kind, userId } = requireRecipient(recipient);
  return moduleAccount(MODULE, `fee-share-owed:${kind}.${userId}`, requireAsset(assetId));
}

export interface FeeShareBudgetFundInput {
  readonly venueId: string;
  /** The venue's own id for the claim that brought this money in, the one `builderFeeReceive` posted. */
  readonly claimId: string;
  readonly assetId: string;
  /** What the claim collected, as the venue records it. */
  readonly claimAmount: Amount;
  /** What is set aside for fee shares out of this claim. One claim funds once. */
  readonly amount: Amount;
}

/** Set collected fee revenue aside for one venue's fee shares: builder-fee revenue → `trade:fee-share-budget:<venueId>`. */
export function feeShareBudgetFund(input: FeeShareBudgetFundInput): PostRequest {
  const venueId = requireVenue(input.venueId);
  const claimId = requireVenueRef('claimId', input.claimId);
  const assetId = requireAsset(input.assetId);
  const claimAmount = requirePositive('claimAmount', input.claimAmount);
  const amount = requirePositive('fee share budget amount', input.amount);
  if (amount > claimAmount) throw new FeeShareOverClaimError(claimAmount, amount);
  return {
    idempotencyKey: requireKey(`fee-share:budget-fund:${venueId}:${claimId}`),
    module: MODULE,
    reason: 'trade.fee_share.budget_funded',
    meta: { venueId, claimId, claimKey: builderFeePayoutKey(venueId, claimId), claimAmount: formatAmount(claimAmount) },
    entries: [credit(houseFees(BUILDER_FEE_POT, assetId), amount), debit(feeShareBudgetAccount(venueId, assetId), amount)],
  };
}

export interface FeeShareOweInput {
  readonly venueId: string;
  /** The venue account and the venue's fill id: the fill's Earn entry this is a share of. */
  readonly venueAccount: string;
  readonly fillId: string;
  readonly recipient: FeeShareRecipient;
  readonly assetId: string;
  /** Our builder fee on that fill, as its Earn entry recorded it. */
  readonly feeEarned: Amount;
  /** The owner's rate. Unset refuses. */
  readonly rate: FeeShareRate;
  /** What this recipient is owed on the fill: at most the rate on the fee; a cap or decay can make it less. */
  readonly amount: Amount;
  /** What all recipients are owed on this fill so far, read from the book by the caller, before this one. */
  readonly sharedSoFarOnFill: Amount;
}

/** Owe a fee share: `trade:fee-share-budget:<venueId>` → `trade:fee-share-owed:<kind>.<userId>`. Refused while the rate is unset. */
export function feeShareOwe(input: FeeShareOweInput): PostRequest {
  const venueId = requireVenue(input.venueId);
  const venueAccount = requireVenueRef('venueAccount', input.venueAccount);
  const fillId = requireVenueRef('fillId', input.fillId);
  const recipient = requireRecipient(input.recipient);
  const assetId = requireAsset(input.assetId);
  const feeEarned = requirePositive('feeEarned', input.feeEarned);
  const amount = requirePositive('fee share amount', input.amount);

  const bps = input.rate?.bps ?? null;
  if (bps === null) throw new FeeShareRateUnsetError();
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_BPS)
    throw new InvalidEntryError('the share rate must be whole basis points from 0 to 10000');
  const sharedSoFar = input.sharedSoFarOnFill;
  if (typeof sharedSoFar !== 'bigint' || sharedSoFar < 0n)
    throw new InvalidEntryError('sharedSoFarOnFill must be what is owed so far, zero or more');

  const atRate = mulBps(feeEarned, bps, 'floor');
  if (amount > atRate) throw new FeeShareExceededError('rate', atRate, amount);
  if (sharedSoFar + amount > feeEarned) throw new FeeShareExceededError('fee', feeEarned, sharedSoFar + amount);

  const earnKey = earnedBuilderFeeKey(venueId, venueAccount, fillId);
  return {
    idempotencyKey: requireKey(`fee-share:${earnKey}:${recipient.kind}:${recipient.userId}`),
    module: MODULE,
    reason: 'trade.fee_share.owed',
    meta: {
      venueId,
      earnKey,
      recipientKind: recipient.kind,
      userId: recipient.userId,
      rateBps: bps,
      feeEarned: formatAmount(feeEarned),
    },
    entries: [credit(feeShareBudgetAccount(venueId, assetId), amount), debit(feeShareOwedAccount(recipient, assetId), amount)],
  };
}

export interface FeeSharePayOutInput {
  readonly recipient: FeeShareRecipient;
  /** Where we pay from: one of our own-funds places. */
  readonly from: OwnFundsPlace;
  /** The recipient's own wallet the chain transaction paid. */
  readonly toWallet: string;
  /** The chain transaction that paid it. */
  readonly chainTx: string;
  readonly assetId: string;
  readonly amount: Amount;
}

/** Pay a fee share we owe, from one of our own-funds places to the recipient's own wallet: what we owe them → the place. */
export function feeSharePayOut(input: FeeSharePayOutInput): PostRequest {
  const recipient = requireRecipient(input.recipient);
  const assetId = requireAsset(input.assetId);
  if (typeof input.chainTx !== 'string' || input.chainTx.length > 128 || !CHAIN_TX.test(input.chainTx)) {
    throw new InvalidEntryError('chainTx must be the chain transaction hash (no spaces or colons, at most 128 characters)');
  }
  if (typeof input.toWallet !== 'string' || !WALLET_ADDRESS.test(input.toWallet)) {
    throw new InvalidEntryError("toWallet must be the recipient's own wallet address (0x and 40 hex characters)");
  }
  const amount = requirePositive('fee share payment amount', input.amount);
  const place = ownFundsPlaceAccount(input.from, assetId);
  return {
    idempotencyKey: requireKey(`fee-share:paid:${recipient.kind}:${recipient.userId}:${assetId}:${input.chainTx}`),
    module: MODULE,
    reason: 'trade.fee_share.paid_out',
    meta: {
      recipientKind: recipient.kind,
      userId: recipient.userId,
      from: place.ownerId,
      toWallet: input.toWallet,
      chainTx: input.chainTx,
    },
    // What we owe comes down; the paying place's balance comes back toward zero (less of ours there). Both are refused by
    // the ledger if they would show less than nothing.
    entries: [credit(feeShareOwedAccount(recipient, assetId), amount), debit(place, amount)],
  };
}
