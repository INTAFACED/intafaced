import type { Amount } from '../money.js';
import { formatAmount, mulBps } from '../money.js';
import type { AccountRef, EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError, LedgerError } from '../types.js';
import { houseFees, partnerFeeReceivable } from '../accounts.js';
import { ownFundsPlaceAccount, type OwnFundsPlace } from './own-funds.js';

/**
 * OUR FEE ON A PAYMENT A LICENSED PARTNER PROCESSED, EARNED AND THEN SETTLED BY THE PARTNER INTO OUR OWN FUNDS (launch money
 * model; project-state OWNER.md item 288, `b1` change 2: "Earn and collect our fee on a partner-processed payment": "Income
 * up, owed by the partner up; then down on its settlement line").
 *
 * At launch INTAFACED holds no customer money (OWNER 226, 288). The customer's payment is the partner's to hold and never
 * enters our book; only our fee on it is ours:
 *
 *   earn    `partner-fee-receivable:<partnerId>` → `fees:<module>`          (keyed by the partner's payment id)
 *   settle  our own-funds place                  → `partner-fee-receivable:…` (keyed by the partner's settlement line id)
 *
 * Earn puts our revenue up and what the partner owes us up (the receivable, a `treasury` boundary, goes below zero). Settle
 * brings what the partner owes back toward zero and records the money now ours at the place. A short settlement leaves the
 * rest owed, as a figure (J-ops-console-26). Only a Settle says money arrived.
 *
 * Every leg is one of INTAFACED's own accounts (`house`, or a `treasury` boundary or place), so neither recipe moves a
 * customer balance, neither is in `customerBalanceRecipes`, and the custody guard needs no change.
 *
 * Refusals:
 * - Earn is refused while our fee rate with that partner is unset (`ledger.partner_fee_rate_unset`). The rate is the
 *   owner's number in the partner's contract; the partner is not named yet, so it has no default (AGENTS.md floor 8). The
 *   recipe computes the fee from the rate and the payment's gross amount, so a caller cannot book a fee the rate does not give.
 * - Settle is refused above what that partner owes us (`balanceAllowed`, `ledger.insufficient_funds`): the excess would be
 *   money that is not ours.
 * - Settle lands only in our treasury wallet or our reserve at that same partner, never at another partner or a venue.
 *
 * What these recipes leave to the partner's rules, which wait for the owner to name the partner (project-state
 * `research/fable-money-2026-11-10/APPROVED.md`): what a chargeback or refund does to our fee, how much the partner holds
 * back in a reserve, and when it settles. None is assumed here.
 *
 * What these recipes cannot check, because a recipe does not read the outside world: that the payment and the settlement
 * line are real and for that amount. The first production caller reads them from the partner's own record before it posts.
 */
const KEY_MAX = 200;
const MAX_BPS = 10_000;

/** A partner id or a module id: lowercase, no `:` or `.`, so a key built from it reads one way only. */
const ID = /^[a-z0-9][a-z0-9_-]*$/;
/** A payment id or a settlement line id: no spaces, no `:`. */
const REF = /^[^\s:]{1,128}$/;

export const PARTNER_FEE_RATE_UNSET_CODE = 'ledger.partner_fee_rate_unset';

/** Refused: the owner has not set our fee rate with this partner, so no fee can be earned. */
export class PartnerFeeRateUnsetError extends LedgerError {
  constructor(readonly partnerId: string) {
    super(
      `Our fee on a payment ${partnerId} processed cannot be earned while the fee rate is unset. The rate is the owner's number; ` +
        'it has no default, so every fee is refused until it is set.',
      PARTNER_FEE_RATE_UNSET_CODE,
    );
    this.name = 'PartnerFeeRateUnsetError';
  }
}

/** The owner's fee rate with one partner, in basis points of the payment's gross amount. `null` or absent means unset. */
export interface PartnerFeeRate {
  readonly bps?: number | null;
}

/** The rate as it stands until the owner names the partner and gives it: unset, so Earn refuses. */
export const PARTNER_FEE_RATE_UNSET: PartnerFeeRate = Object.freeze({ bps: null });

function requireId(name: string, value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new InvalidEntryError(`${name} must be a lower-case id with no ':' or '.'`);
  return value;
}

function requireRef(name: string, value: unknown): string {
  if (typeof value !== 'string' || !REF.test(value)) {
    throw new InvalidEntryError(`${name} must be an id of at most 128 characters with no spaces or colons`);
  }
  return value;
}

function requireAsset(assetId: unknown): string {
  if (typeof assetId !== 'string' || !assetId.trim() || assetId.trim() !== assetId) {
    throw new InvalidEntryError('assetId is required, with no surrounding spaces');
  }
  return assetId;
}

function requireKey(key: string): string {
  if (key.length > KEY_MAX) throw new InvalidEntryError(`the post key would be longer than ${KEY_MAX} characters`);
  return key;
}

const debit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'debit', amount });
const credit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'credit', amount });

/** What one partner owes us in fees, in one asset. */
export function partnerFeeReceivableAccount(partnerId: string, assetId: string): AccountRef {
  return partnerFeeReceivable(requireId('partnerId', partnerId), requireAsset(assetId));
}

export function earnedPartnerFeeKey(partnerId: string, paymentId: string): string {
  return `partner-fee:earned:${partnerId}:${paymentId}`;
}

export interface PartnerFeeEarnInput {
  /** The partner that processed the payment. */
  readonly partnerId: string;
  /** The module the payment belongs to (e.g. `merchant`): our fee lands in `fees:<module>`. */
  readonly module: string;
  /** The partner's own id for the payment. One payment earns once. */
  readonly paymentId: string;
  readonly assetId: string;
  /** The payment's gross amount, as the partner records it. The customer's money: it never enters our book. */
  readonly grossAmount: Amount;
  /** The owner's rate with this partner. Unset refuses. */
  readonly rate: PartnerFeeRate;
}

/** Earn our fee on a partner-processed payment: `partner-fee-receivable:<partnerId>` → `fees:<module>`. Refused while the rate is unset. */
export function partnerFeeEarn(input: PartnerFeeEarnInput): PostRequest {
  const partnerId = requireId('partnerId', input.partnerId);
  const module = requireId('module', input.module);
  const paymentId = requireRef('paymentId', input.paymentId);
  const assetId = requireAsset(input.assetId);
  if (typeof input.grossAmount !== 'bigint' || input.grossAmount <= 0n) throw new InvalidEntryError('the payment must be above zero');

  const bps = input.rate?.bps ?? null;
  if (bps === null) throw new PartnerFeeRateUnsetError(partnerId);
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_BPS)
    throw new InvalidEntryError('the fee rate must be whole basis points from 0 to 10000');
  // Rounded down: we never book more fee than the rate gives.
  const fee = mulBps(input.grossAmount, bps, 'floor');
  if (fee === 0n) throw new InvalidEntryError('our fee must be above zero; a payment with no fee posts nothing');

  return {
    idempotencyKey: requireKey(earnedPartnerFeeKey(partnerId, paymentId)),
    module,
    reason: 'partner_fee.earned',
    meta: { partnerId, paymentId, grossAmount: formatAmount(input.grossAmount), rateBps: bps },
    entries: [debit(houseFees(module, assetId), fee), credit(partnerFeeReceivableAccount(partnerId, assetId), fee)],
  };
}

export interface PartnerFeeSettleInput {
  readonly partnerId: string;
  /** The module the fees were earned in; the post carries it. */
  readonly module: string;
  /** Where the partner paid us: our treasury wallet, or our reserve at this same partner. */
  readonly to: OwnFundsPlace;
  /** The partner's settlement line id for this payment of our fees. */
  readonly settlementLineId: string;
  readonly assetId: string;
  readonly amount: Amount;
}

export function settledPartnerFeeKey(partnerId: string, assetId: string, settlementLineId: string): string {
  return `partner-fee:settled:${partnerId}:${assetId}:${settlementLineId}`;
}

/** Settle our fees: what the partner owes us comes down; the place records the money now ours. Refused above what is owed. */
export function partnerFeeSettle(input: PartnerFeeSettleInput): PostRequest {
  const partnerId = requireId('partnerId', input.partnerId);
  const module = requireId('module', input.module);
  const settlementLineId = requireRef('settlementLineId', input.settlementLineId);
  const assetId = requireAsset(input.assetId);
  if (typeof input.amount !== 'bigint' || input.amount <= 0n) throw new InvalidEntryError('a settlement must be above zero');
  const to = input.to;
  const allowed = to?.kind === 'treasury-wallet' || (to?.kind === 'partner-reserve' && to.partnerId === partnerId);
  if (!allowed)
    throw new InvalidEntryError('a partner settles our fees into our treasury wallet or our reserve at that partner, nowhere else');
  const place = ownFundsPlaceAccount(to, assetId);
  return {
    // Keyed on the partner's own settlement line, so one line is settled once.
    idempotencyKey: requireKey(settledPartnerFeeKey(partnerId, assetId, settlementLineId)),
    module,
    reason: 'partner_fee.settled',
    meta: { partnerId, to: place.ownerId, settlementLineId },
    // The receivable comes back toward zero (refused above zero); the place goes further below zero (more of ours there).
    entries: [debit(partnerFeeReceivableAccount(partnerId, assetId), input.amount), credit(place, input.amount)],
  };
}
