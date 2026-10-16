import type { Amount } from '../money.js';
import type { AccountRef, EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError } from '../types.js';
import { conversionInventory, houseFees, merchantClearing, merchantClearingHold, userAvailable, venueBoundary } from '../accounts.js';

/**
 * USD → USDT CONVERSION (W6, sandbox / testnet only).
 *
 * The hold moves the merchant's clearing into a purpose pot before any venue
 * call, so a second attempt cannot spend the same USD. The fill consumes that
 * hold and records the venue boundary: USD sits at the venue, USDT comes back.
 * Fee and spread the pricing rule locked go to house revenue. A zero fee or
 * spread is omitted.
 *
 * A fill under the quoted minimum is reversed onto house inventory. The reverse
 * does not touch the venue boundary — those legs stay as the fill posted them,
 * so the book still shows the venue exposure. The merchant's USD is restored
 * from inventory, which runs negative by that short (it is a treasury pot).
 */

const debit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'debit', amount });
const credit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'credit', amount });

function requirePositive(name: string, value: Amount): void {
  if (value <= 0n) throw new InvalidEntryError(`${name} must be positive`);
}

function requireNonNegative(name: string, value: Amount): void {
  if (value < 0n) throw new InvalidEntryError(`${name} must not be negative`);
}

export interface FxConversionInput {
  /** One conversion attempt. The idempotency key. */
  conversionId: string;
  merchantId: string;
  /** The merchant's own user account — where the USDT lands. */
  merchantUserId: string;
  /** Venue id, the boundary the inventory sits at. Not a balance we invent. */
  venueId: string;
  fromAsset: string;
  toAsset: string;
  /** From-asset size that actually moved (a partial fill is not the whole order). */
  fromAmount: Amount;
  /** To-asset the merchant receives, after venue commission. */
  toAmount: Amount;
  /** To-asset. Zero omits the leg. */
  feeAmount: Amount;
  /** To-asset. Zero omits the leg. */
  spreadAmount: Amount;
}

export interface FxConversionHoldInput {
  conversionId: string;
  merchantId: string;
  fromAsset: string;
  amount: Amount;
}

function assertId(conversionId: string): void {
  if (!conversionId.trim()) throw new InvalidEntryError('conversionId is required');
}

function assertInput(input: FxConversionInput): void {
  assertId(input.conversionId);
  if (!input.venueId.trim()) throw new InvalidEntryError('venueId is required');
  if (input.fromAsset === input.toAsset) throw new InvalidEntryError('conversion assets must differ');
  requirePositive('conversion from amount', input.fromAmount);
  requirePositive('conversion to amount', input.toAmount);
  requireNonNegative('conversion fee', input.feeAmount);
  requireNonNegative('conversion spread', input.spreadAmount);
}

function assertHold(input: FxConversionHoldInput): void {
  assertId(input.conversionId);
  if (!input.merchantId.trim()) throw new InvalidEntryError('merchantId is required');
  if (!input.fromAsset.trim()) throw new InvalidEntryError('fromAsset is required');
  requirePositive('conversion hold amount', input.amount);
}

/** Book a conversion fill. USD and USDT each sum to zero on their own. The from-asset leaves the hold, not free clearing. */
export function fxConversion(input: FxConversionInput): PostRequest {
  assertInput(input);
  const grossTo = input.toAmount + input.feeAmount + input.spreadAmount;
  return {
    idempotencyKey: `pay.conversion:${input.conversionId}`,
    module: 'pay',
    reason: 'pay.conversion.booked',
    meta: {
      conversionId: input.conversionId,
      merchantId: input.merchantId,
      venueId: input.venueId,
      fromAsset: input.fromAsset,
      toAsset: input.toAsset,
    },
    entries: [
      credit(merchantClearingHold(input.merchantId, input.fromAsset, input.conversionId), input.fromAmount),
      debit(venueBoundary(input.venueId, input.fromAsset), input.fromAmount),
      credit(venueBoundary(input.venueId, input.toAsset), grossTo),
      debit(userAvailable(input.merchantUserId, input.toAsset), input.toAmount),
      ...(input.feeAmount > 0n ? [debit(houseFees('pay', input.toAsset), input.feeAmount)] : []),
      ...(input.spreadAmount > 0n ? [debit(houseFees('pay', input.toAsset), input.spreadAmount)] : []),
    ],
  };
}

/**
 * Undo the merchant's receipt of a booked fill. The venue-boundary legs are
 * not in this post: the fill already recorded them, and reversing them would
 * show a flat venue after a trade that happened. USDT the merchant and the
 * fee pot received moves to house inventory. The merchant's USD is restored
 * from that same inventory.
 */
export function fxConversionReverse(input: FxConversionInput): PostRequest {
  assertInput(input);
  const grossTo = input.toAmount + input.feeAmount + input.spreadAmount;
  return {
    idempotencyKey: `pay.conversion.reverse:${input.conversionId}`,
    module: 'pay',
    reason: 'pay.conversion.reversed',
    meta: {
      conversionId: input.conversionId,
      merchantId: input.merchantId,
      venueId: input.venueId,
      fromAsset: input.fromAsset,
      toAsset: input.toAsset,
    },
    entries: [
      debit(merchantClearing(input.merchantId, input.fromAsset), input.fromAmount),
      credit(conversionInventory(input.fromAsset), input.fromAmount),
      credit(userAvailable(input.merchantUserId, input.toAsset), input.toAmount),
      debit(conversionInventory(input.toAsset), grossTo),
      ...(input.feeAmount > 0n ? [credit(houseFees('pay', input.toAsset), input.feeAmount)] : []),
      ...(input.spreadAmount > 0n ? [credit(houseFees('pay', input.toAsset), input.spreadAmount)] : []),
    ],
  };
}

/** Reserve clearing for one attempt. The intent transaction posts this before the venue is called. */
export function fxConversionHold(input: FxConversionHoldInput): PostRequest {
  assertHold(input);
  return {
    idempotencyKey: `pay.conversion.hold:${input.conversionId}`,
    module: 'pay',
    reason: 'pay.conversion.held',
    meta: { conversionId: input.conversionId, merchantId: input.merchantId, fromAsset: input.fromAsset },
    entries: [
      credit(merchantClearing(input.merchantId, input.fromAsset), input.amount),
      debit(merchantClearingHold(input.merchantId, input.fromAsset, input.conversionId), input.amount),
    ],
  };
}

/**
 * Return reserved clearing that the venue did not fill.
 * `sequence` separates a full release from a partial remainder. A retry of the
 * same sequence must carry the same amount.
 */
export function fxConversionRelease(input: FxConversionHoldInput & { sequence?: number }): PostRequest {
  assertHold(input);
  return {
    idempotencyKey: `pay.conversion.release:${input.conversionId}:${input.sequence ?? 0}`,
    module: 'pay',
    reason: 'pay.conversion.released',
    meta: { conversionId: input.conversionId, merchantId: input.merchantId, fromAsset: input.fromAsset },
    entries: [
      credit(merchantClearingHold(input.merchantId, input.fromAsset, input.conversionId), input.amount),
      debit(merchantClearing(input.merchantId, input.fromAsset), input.amount),
    ],
  };
}
