import type { Amount } from '../money.js';
import type { AccountRef, EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError } from '../types.js';
import {
  futuresOrderMarginAccount,
  positionCollateralAccount,
  subAccountAvailable,
  subAccountFuturesOrderMargin,
  subAccountPositionCollateral,
  userAvailable,
} from '../accounts.js';

/**
 * FUTURES ORDER MARGIN (docs/adr/2026-10-20-futures-matched-traders.md §8, slice 5).
 *
 * An order that opens or grows a position locks its initial margin before it
 * rests, so a fill never needs money the trader no longer has. The hold sits in
 * a pot of its own per order (`futures-order:<orderId>`), never in the position
 * pot (the position may not exist yet) and never in the spot order hold.
 *
 *   hold    available → order margin     when the order is accepted
 *   release order margin → available     on cancel, expiry or a reduced order
 *   apply   order margin → position pot  on a fill, with any unused part of the
 *                                        hold returned in the same posting
 *
 * The amounts come from the engine (mark, leverage, limit price). These recipes
 * never choose a price or a size.
 */

const debit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'debit', amount });
const credit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'credit', amount });

function requireText(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidEntryError(`${name} is required for futures order margin`);
  }
  return value;
}

function requirePositive(name: string, value: Amount): void {
  if (typeof value !== 'bigint' || value <= 0n) throw new InvalidEntryError(`${name} must be positive`);
}

function requireSequence(sequence: number | undefined): number {
  const value = sequence ?? 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidEntryError('futures order margin release sequence must be an integer >= 0');
  }
  return value;
}

export interface FuturesOrderMarginInput {
  orderId: string;
  userId: string;
  /** Margin asset (the quote asset of the market). */
  assetId: string;
  amount: Amount;
  /** When set, the available pot and the order margin pot are this sub-account's. */
  subAccountId?: string;
}

function orderPots(input: { orderId: string; userId: string; assetId: string; subAccountId?: string }): {
  orderId: string;
  subAccountId: string;
  available: AccountRef;
  orderMargin: AccountRef;
} {
  const orderId = requireText('orderId', input.orderId);
  const assetId = requireText('assetId', input.assetId);
  const subAccountId = input.subAccountId?.trim() ?? '';
  if (subAccountId) {
    return {
      orderId,
      subAccountId,
      available: subAccountAvailable(subAccountId, assetId),
      orderMargin: subAccountFuturesOrderMargin(subAccountId, assetId, orderId),
    };
  }
  const userId = requireText('userId', input.userId);
  return {
    orderId,
    subAccountId: '',
    available: userAvailable(userId, assetId),
    orderMargin: futuresOrderMarginAccount(userId, assetId, orderId),
  };
}

const subMeta = (subAccountId: string): { subAccountId?: string } => (subAccountId ? { subAccountId } : {});

/** Reserve initial margin for one resting futures order. Keyed on the order. */
export function futuresOrderMarginHold(input: FuturesOrderMarginInput): PostRequest {
  const pots = orderPots(input);
  requirePositive('futures order margin hold amount', input.amount);
  return {
    idempotencyKey: `futures.order.margin.hold:${pots.orderId}`,
    module: 'trade',
    reason: 'futures.order.margin.hold',
    meta: { orderId: pots.orderId, ...subMeta(pots.subAccountId) },
    entries: [credit(pots.available, input.amount), debit(pots.orderMargin, input.amount)],
  };
}

/**
 * Return unused order margin to available (cancel, expiry, a smaller order).
 * `sequence` keeps repeated partial returns of one order apart; the same
 * sequence is the same release, and posts once.
 */
export function futuresOrderMarginRelease(input: FuturesOrderMarginInput & { sequence?: number }): PostRequest {
  const pots = orderPots(input);
  requirePositive('futures order margin release amount', input.amount);
  const sequence = requireSequence(input.sequence);
  return {
    idempotencyKey: `futures.order.margin.release:${pots.orderId}:${sequence}`,
    module: 'trade',
    reason: 'futures.order.margin.release',
    meta: { orderId: pots.orderId, sequence, ...subMeta(pots.subAccountId) },
    entries: [credit(pots.orderMargin, input.amount), debit(pots.available, input.amount)],
  };
}

export interface FuturesOrderMarginApplyInput {
  orderId: string;
  userId: string;
  assetId: string;
  positionId: string;
  /**
   * One fill of this order, as its business key, for example
   * `<marketId>:<sequence>:<positionId>`. A retry of the same fill posts once.
   */
  fillId: string;
  /** Margin that moves from the order's hold into the position's pot. */
  amount: Amount;
  /**
   * Part of the hold this fill does not need (a fill at a better price than
   * the limit). Returned to available in the same posting, so no crash can
   * leave it stranded between the two. Zero returns nothing.
   */
  releaseAmount?: Amount;
  subAccountId?: string;
}

/** Move a fill's margin from the order's hold into the position's collateral pot. */
export function futuresOrderMarginApply(input: FuturesOrderMarginApplyInput): PostRequest {
  const pots = orderPots(input);
  const positionId = requireText('positionId', input.positionId);
  const fillId = requireText('fillId', input.fillId);
  requirePositive('futures order margin apply amount', input.amount);
  const release = input.releaseAmount ?? 0n;
  if (typeof release !== 'bigint' || release < 0n) {
    throw new InvalidEntryError('futures order margin apply release amount must not be negative');
  }
  const collateral = pots.subAccountId
    ? subAccountPositionCollateral(pots.subAccountId, input.assetId, positionId)
    : positionCollateralAccount(input.userId, input.assetId, positionId);
  return {
    idempotencyKey: `futures.fill:${fillId}`,
    module: 'trade',
    reason: 'futures.order.margin.applied',
    meta: {
      orderId: pots.orderId,
      positionId,
      fillId,
      amount: input.amount.toString(),
      released: release.toString(),
      ...subMeta(pots.subAccountId),
    },
    // The ledger funds a lock only from the same owner's available balance in
    // the same posting (INVARIANT 2), so the hold is drawn through available:
    // the whole hold gives up its share, `amount` goes on into the position
    // pot, and `release` is what stays behind. One posting, so no crash can
    // leave margin between the two pots.
    entries: [
      credit(pots.orderMargin, input.amount + release),
      debit(pots.available, input.amount + release),
      credit(pots.available, input.amount),
      debit(collateral, input.amount),
    ],
  };
}
