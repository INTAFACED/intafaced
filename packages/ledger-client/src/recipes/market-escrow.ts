import { add, mulBps, sub, type Amount } from '../money.js';
import type { AccountRef, EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError } from '../types.js';
import { houseFees, userAvailable, userEscrow } from '../accounts.js';

/**
 * MARKET PURCHASE HELD UNTIL ITS REFUND WINDOW ENDS (§8.7, J-more-catalogue-02 #4 to #6).
 *
 * A purchase with a refund window is charged into a pot of its own, owned by the
 * buyer (`market:purchase:<purchaseId>`). The seller sees nothing while it is held.
 *
 *   hold     buyer available → buyer escrow `market:purchase:<purchaseId>`   market:hold:<purchaseId>
 *   refund   buyer escrow    → buyer available                                market:refund:<purchaseId>:<n>
 *   release  buyer escrow    → seller available (net) + houseFees(market)    market:release:<purchaseId>
 *
 * Refunds are numbered by svc-market (1, 2, …, allocated with the refund row) so a
 * retried refund posts once and a second, separate refund gets its own key. Release
 * moves exactly what is left: the caller states the held amount and the total
 * refunded, and any other release amount is refused (`MarketReleaseRemainderError`),
 * so a release can never leave a remainder behind its one key. The ledger's
 * non-negative escrow balance refuses a refund or release larger than what is held,
 * so the pot can never pay out twice.
 * The window, the refund policy and the commission are svc-market's; these recipes
 * never choose an amount, a date or a rate.
 *
 * Commission rounding is floor (customer favour), as `marketPurchase`; seller net
 * and commission always sum exactly to the released amount.
 */

const debit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'debit', amount });
const credit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'credit', amount });

function requireText(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidEntryError(`${name} is required for a held market purchase`);
  }
  return value.trim();
}

function requirePositive(name: string, value: Amount): void {
  if (typeof value !== 'bigint' || value <= 0n) throw new InvalidEntryError(`${name} must be positive`);
}

/** The buyer's pot for one held purchase. Ids are trimmed exactly as the recipes trim them. */
export function marketPurchaseEscrowAccount(buyerId: string, assetId: string, purchaseId: string): AccountRef {
  return userEscrow(
    requireText('buyerId', buyerId),
    requireText('assetId', assetId),
    `market:purchase:${requireText('purchaseId', purchaseId)}`,
  );
}

/** A release that would not empty the pot. */
export class MarketReleaseRemainderError extends InvalidEntryError {
  constructor() {
    super('market.release_remainder: a held purchase is released for exactly what is left (held minus refunded)');
    this.name = 'MarketReleaseRemainderError';
  }
}

export interface MarketPurchaseHeldInput {
  /** svc-market's purchase id: the business key of every post on this pot. */
  purchaseId: string;
  listingId: string;
  buyerId: string;
  assetId: string;
  amount: Amount;
}

export interface MarketPurchaseRefundInput extends MarketPurchaseHeldInput {
  /** 1 for the first refund on this purchase, 2 for the next. A retry reuses its number. */
  refundNo: number;
}

export interface MarketPurchaseReleaseInput extends MarketPurchaseHeldInput {
  /** The amount `marketPurchaseHold` placed for this purchase. */
  heldAmount: Amount;
  /** The sum of every refund posted for this purchase ('0' when none). `amount` must equal held minus refunded. */
  refundedAmount: Amount;
  vendorUserId: string;
  /** House commission in basis points (0..9999). Required: a blank commission is never zero. */
  commissionBps: number;
}

function pot(input: MarketPurchaseHeldInput) {
  const purchaseId = requireText('purchaseId', input.purchaseId);
  const listingId = requireText('listingId', input.listingId);
  const buyerId = requireText('buyerId', input.buyerId);
  const assetId = requireText('assetId', input.assetId);
  return {
    purchaseId,
    listingId,
    buyerId,
    assetId,
    escrow: userEscrow(buyerId, assetId, `market:purchase:${purchaseId}`),
    available: userAvailable(buyerId, assetId),
  };
}

/** Charge a purchase into its held pot: buyer available → buyer escrow. */
export function marketPurchaseHold(input: MarketPurchaseHeldInput): PostRequest {
  requirePositive('held purchase amount', input.amount);
  const p = pot(input);
  return {
    idempotencyKey: `market:hold:${p.purchaseId}`,
    module: 'market',
    reason: 'market.purchase.held',
    meta: { purchaseId: p.purchaseId, listingId: p.listingId },
    entries: [credit(p.available, input.amount), debit(p.escrow, input.amount)],
  };
}

/** Return part or all of a held purchase to the buyer: buyer escrow → buyer available. */
export function marketPurchaseRefund(input: MarketPurchaseRefundInput): PostRequest {
  requirePositive('refund amount', input.amount);
  if (!Number.isSafeInteger(input.refundNo) || input.refundNo < 1) {
    throw new InvalidEntryError(`market refundNo must be a whole number from 1, got ${input.refundNo}`);
  }
  const p = pot(input);
  return {
    idempotencyKey: `market:refund:${p.purchaseId}:${input.refundNo}`,
    module: 'market',
    reason: 'market.purchase.refunded',
    meta: { purchaseId: p.purchaseId, listingId: p.listingId, refundNo: input.refundNo },
    entries: [credit(p.escrow, input.amount), debit(p.available, input.amount)],
  };
}

/** Pay out what is left of a held purchase: buyer escrow → seller net + house commission. */
export function marketPurchaseRelease(input: MarketPurchaseReleaseInput): PostRequest {
  requirePositive('release amount', input.amount);
  if (!Number.isInteger(input.commissionBps) || input.commissionBps < 0 || input.commissionBps > 9_999) {
    throw new InvalidEntryError(`market commissionBps must be an integer in 0..9999, got ${input.commissionBps}`);
  }
  requirePositive('held amount', input.heldAmount);
  if (typeof input.refundedAmount !== 'bigint' || input.refundedAmount < 0n) {
    throw new InvalidEntryError('refunded amount must be zero or more');
  }
  if (add(input.amount, input.refundedAmount) !== input.heldAmount) throw new MarketReleaseRemainderError();
  const p = pot(input);
  const vendorUserId = requireText('vendorUserId', input.vendorUserId);
  if (vendorUserId === p.buyerId) throw new InvalidEntryError('buyer and vendor must be different users');
  // Floor with bps ≤ 9999 leaves the vendor at least one unit of a positive amount.
  const commission = mulBps(input.amount, input.commissionBps, 'floor');
  const vendorNet = sub(input.amount, commission);
  return {
    idempotencyKey: `market:release:${p.purchaseId}`,
    module: 'market',
    reason: 'market.purchase.released',
    meta: {
      purchaseId: p.purchaseId,
      listingId: p.listingId,
      commissionBps: input.commissionBps,
      commission: commission.toString(),
      vendorNet: vendorNet.toString(),
    },
    entries: [
      credit(p.escrow, input.amount),
      debit(userAvailable(vendorUserId, p.assetId), vendorNet),
      ...(commission > 0n ? [debit(houseFees('market', p.assetId), commission)] : []),
    ],
  };
}
