import type { Amount } from '../money.js';
import { formatAmount } from '../money.js';
import type { AccountRef, EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError, LedgerError, isValidOwnerId } from '../types.js';
import { chargeReceivable, houseFees } from '../accounts.js';
import { ownFundsPlaceAccount, type OwnFundsPlace } from './own-funds.js';

/**
 * A CHARGE A CUSTOMER OWES US, EARNED AND THEN COLLECTED INTO ONE OF OUR OWN-FUNDS PLACES (launch money model; project-state
 * OWNER.md item 288, `b1` change 2: "Earn a charge a customer owes us" and "Collect it"). Agent usage, an academy course, a
 * subscription period: anything we sell for a price the owner sets.
 *
 * At launch INTAFACED holds no customer money, so a charge is never debited from a customer balance in our book (that is the
 * custodial `feeCharge`, refused with custody off). The customer pays it from their own wallet or through a partner, and the
 * money arrives at one of our own places:
 *
 *   earn     `charge-receivable:<module>.<userId>` → `fees:<module>`              (keyed by the sale or the usage window)
 *   collect  our own-funds place                   → `charge-receivable:…`       (keyed by the chain's or partner's payment id)
 *
 * Earn puts our revenue up and what the customer owes us up (the receivable, a `treasury` boundary, goes below zero). Collect
 * brings what they owe back toward zero and records the money now ours at the place. "Earned" and "collected" stay two
 * figures; only a Collect says money arrived.
 *
 * Every leg is one of INTAFACED's own accounts (`house`, or a `treasury` boundary or place), so neither recipe moves a
 * customer balance, neither is in `customerBalanceRecipes`, and the custody guard needs no change.
 *
 * Refusals:
 * - Earn is refused while the price is unset (`ledger.charge_price_unset`). The price is the owner's number; it has no
 *   default (AGENTS.md floor 8). The recipe computes the amount from the price and the units, so a caller cannot charge an
 *   amount the price does not give.
 * - Collect is refused above what that customer owes us for that module's charges: a charge receivable may never go above
 *   zero (`balanceAllowed`, `ledger.insufficient_funds`), because the excess would be the customer's money in our book.
 * - Collect lands only at an own-funds place (`ownFundsPlaceAccount`).
 *
 * What these recipes cannot check, because a recipe does not read the outside world: that the payment named really arrived
 * at that place for that amount. The first production caller reads it from the chain or the partner's record before it posts.
 */
const KEY_MAX = 200;

/** A selling module, as its fee pot names it (`fees:<module>`): lowercase, no `:` or `.`. */
const MODULE_ID = /^[a-z0-9][a-z0-9_-]*$/;
/** A sale id, a usage window id, or a payment id: no spaces, no `:`. */
const REF = /^[^\s:]+$/;

export const CHARGE_PRICE_UNSET_CODE = 'ledger.charge_price_unset';

/** Refused: the owner has not set the price, so nothing can be charged. */
export class ChargePriceUnsetError extends LedgerError {
  constructor(readonly module: string) {
    super(
      `A charge for ${module} cannot be earned while its price is unset. The price is the owner's number; it has no default, so ` +
        'every charge is refused until it is set.',
      CHARGE_PRICE_UNSET_CODE,
    );
    this.name = 'ChargePriceUnsetError';
  }
}

/** The owner's price for one unit, in the charge's asset. `null` or absent means unset, and unset refuses. */
export interface ChargePrice {
  readonly perUnit?: Amount | null;
}

/** The price as it stands until the owner gives it: unset, so Earn refuses. */
export const CHARGE_PRICE_UNSET: ChargePrice = Object.freeze({ perUnit: null });

function requireModule(module: unknown): string {
  if (typeof module !== 'string' || !MODULE_ID.test(module)) throw new InvalidEntryError('module must be a lower-case module id');
  return module;
}

function requireRef(name: string, value: unknown): string {
  if (typeof value !== 'string' || !REF.test(value)) throw new InvalidEntryError(`${name} must be an id with no spaces or colons`);
  return value;
}

function requireAsset(assetId: unknown): string {
  if (typeof assetId !== 'string' || !assetId.trim() || assetId.trim() !== assetId) {
    throw new InvalidEntryError('assetId is required, with no surrounding spaces');
  }
  return assetId;
}

function requireUser(userId: unknown): string {
  if (typeof userId !== 'string' || !isValidOwnerId('user', userId)) {
    throw new InvalidEntryError("userId must be the customer's id as stored (a lowercase UUID)");
  }
  return userId;
}

function requireKey(key: string): string {
  if (key.length > KEY_MAX) throw new InvalidEntryError(`the post key would be longer than ${KEY_MAX} characters`);
  return key;
}

const debit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'debit', amount });
const credit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'credit', amount });

/** What one customer owes us for one module's charges, in one asset. */
export function chargeReceivableAccount(module: string, userId: string, assetId: string): AccountRef {
  return chargeReceivable(requireModule(module), requireUser(userId), requireAsset(assetId));
}

export function earnedChargeKey(module: string, saleId: string): string {
  return `charge:earned:${module}:${saleId}`;
}

export interface ChargeEarnInput {
  /** The selling module: its revenue lands in `fees:<module>`. */
  readonly module: string;
  /** The sale id, or the usage window id for metered usage. One sale earns once. */
  readonly saleId: string;
  /** The customer who owes it. Named in the receivable, never a balance of theirs. */
  readonly userId: string;
  readonly assetId: string;
  /** The owner's price for one unit. Unset refuses. */
  readonly price: ChargePrice;
  /** How many units were sold or used: a whole number, at least one. */
  readonly units: bigint;
}

/** Earn a charge a customer owes us: `charge-receivable:<module>.<userId>` → `fees:<module>`. Refused while the price is unset. */
export function chargeEarn(input: ChargeEarnInput): PostRequest {
  const module = requireModule(input.module);
  const saleId = requireRef('saleId', input.saleId);
  const userId = requireUser(input.userId);
  const assetId = requireAsset(input.assetId);
  if (typeof input.units !== 'bigint' || input.units < 1n) throw new InvalidEntryError('units must be a whole number, at least one');

  const perUnit = input.price?.perUnit ?? null;
  if (perUnit === null) throw new ChargePriceUnsetError(module);
  if (typeof perUnit !== 'bigint' || perUnit < 0n) throw new InvalidEntryError('the price must be an amount, zero or more');
  const amount = perUnit * input.units;
  if (amount === 0n) throw new InvalidEntryError('a charge must be above zero; a free sale posts nothing');

  return {
    idempotencyKey: requireKey(earnedChargeKey(module, saleId)),
    module,
    reason: 'charge.earned',
    meta: { saleId, userId, perUnit: formatAmount(perUnit), units: input.units.toString() },
    entries: [debit(houseFees(module, assetId), amount), credit(chargeReceivableAccount(module, userId, assetId), amount)],
  };
}

export interface ChargeCollectInput {
  readonly module: string;
  readonly userId: string;
  /** Where the payment arrived: one of our own-funds places. */
  readonly to: OwnFundsPlace;
  /** The chain transaction hash, or the partner's payment id, for this payment. */
  readonly paymentId: string;
  readonly assetId: string;
  readonly amount: Amount;
}

/** Collect a charge: what the customer owes us comes down; the place records the money now ours. */
export function chargeCollect(input: ChargeCollectInput): PostRequest {
  const module = requireModule(input.module);
  const userId = requireUser(input.userId);
  const assetId = requireAsset(input.assetId);
  const paymentId = requireRef('paymentId', input.paymentId);
  if (paymentId.length > 128) throw new InvalidEntryError('paymentId must be at most 128 characters');
  if (typeof input.amount !== 'bigint' || input.amount <= 0n) throw new InvalidEntryError('a collected charge must be above zero');
  const place = ownFundsPlaceAccount(input.to, assetId);
  return {
    // Keyed on the outside record of the payment at that place, so one payment is collected once, for one customer.
    idempotencyKey: requireKey(`charge:collected:${place.ownerId}:${assetId}:${paymentId}`),
    module,
    reason: 'charge.collected',
    meta: { userId, to: place.ownerId, paymentId },
    // The receivable comes back toward zero (refused above zero); the place goes further below zero (more of ours there).
    entries: [debit(chargeReceivableAccount(module, userId, assetId), input.amount), credit(place, input.amount)],
  };
}
