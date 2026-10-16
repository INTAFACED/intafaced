import type { Amount } from '../money.js';
import type { AccountRef, EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError } from '../types.js';
import { houseFees, merchantClearing, userAvailable, venueBoundary } from '../accounts.js';

/**
 * USD → USDT CONVERSION (W6, sandbox / testnet only).
 *
 * Two assets, two balanced pairs. USD leaves the merchant's clearing pot and
 * sits at the venue boundary. USDT comes back from that boundary: the merchant's
 * spendable balance receives the net, and any fee or spread the pricing rule
 * locked goes to house revenue. A zero fee or spread is omitted — a zero leg is
 * not a posting. The reverse is a separate transaction, the same shape run
 * backwards, so a fill under the quoted minimum can be undone without editing
 * the first post.
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
  /** To-asset the merchant receives. */
  toAmount: Amount;
  /** To-asset. Zero omits the leg. */
  feeAmount: Amount;
  /** To-asset. Zero omits the leg. */
  spreadAmount: Amount;
}

function assertInput(input: FxConversionInput): void {
  if (!input.conversionId.trim()) throw new InvalidEntryError('conversionId is required');
  if (!input.venueId.trim()) throw new InvalidEntryError('venueId is required');
  if (input.fromAsset === input.toAsset) throw new InvalidEntryError('conversion assets must differ');
  requirePositive('conversion from amount', input.fromAmount);
  requirePositive('conversion to amount', input.toAmount);
  requireNonNegative('conversion fee', input.feeAmount);
  requireNonNegative('conversion spread', input.spreadAmount);
}

/** Book a conversion fill. USD and USDT each sum to zero on their own. */
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
      credit(merchantClearing(input.merchantId, input.fromAsset), input.fromAmount),
      debit(venueBoundary(input.venueId, input.fromAsset), input.fromAmount),
      credit(venueBoundary(input.venueId, input.toAsset), grossTo),
      debit(userAvailable(input.merchantUserId, input.toAsset), input.toAmount),
      ...(input.feeAmount > 0n ? [debit(houseFees('pay', input.toAsset), input.feeAmount)] : []),
      ...(input.spreadAmount > 0n ? [debit(houseFees('pay', input.toAsset), input.spreadAmount)] : []),
    ],
  };
}

/**
 * Undo a booked fill. Same amounts, opposite directions, its own key — the
 * first post stays in the journal.
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
      credit(venueBoundary(input.venueId, input.fromAsset), input.fromAmount),
      debit(merchantClearing(input.merchantId, input.fromAsset), input.fromAmount),
      credit(userAvailable(input.merchantUserId, input.toAsset), input.toAmount),
      debit(venueBoundary(input.venueId, input.toAsset), grossTo),
      ...(input.feeAmount > 0n ? [credit(houseFees('pay', input.toAsset), input.feeAmount)] : []),
      ...(input.spreadAmount > 0n ? [credit(houseFees('pay', input.toAsset), input.spreadAmount)] : []),
    ],
  };
}
