import type { Amount } from '../money.js';
import type { EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError } from '../types.js';
import { houseFees, userAvailable } from '../accounts.js';

/**
 * A posted fill fee is not deleted. The correction is a second balanced entry
 * under a new idempotency key. It moves the excess fee from house trade fees
 * back to the user who was charged. It does not edit `trade.fill`.
 */
export interface TradeFillFeeCorrectionInput {
  fillId: string;
  /** Caller-supplied id. The key is not `trade.fill:<fillId>`. */
  correctionId: string;
  /** User who was charged the fee that is being given back. */
  userId: string;
  assetId: string;
  /** Excess already inside the posted fill. Positive. */
  difference: Amount;
}

const debit = (account: ReturnType<typeof userAvailable> | ReturnType<typeof houseFees>, amount: Amount): EntryInput => ({
  account,
  direction: 'debit',
  amount,
});
const credit = (account: ReturnType<typeof userAvailable> | ReturnType<typeof houseFees>, amount: Amount): EntryInput => ({
  account,
  direction: 'credit',
  amount,
});

export function tradeFillFeeCorrection(input: TradeFillFeeCorrectionInput): PostRequest {
  if (input.difference <= 0n) throw new InvalidEntryError('fee correction difference must be positive');
  const fillId = input.fillId?.trim() ?? '';
  const correctionId = input.correctionId?.trim() ?? '';
  if (!fillId) throw new InvalidEntryError('fillId is required');
  if (!correctionId) throw new InvalidEntryError('A fee correction is a new key');
  if (!input.userId?.trim()) throw new InvalidEntryError('userId is required');
  if (!input.assetId?.trim()) throw new InvalidEntryError('assetId is required');

  const idempotencyKey = `trade.fill.fee.correction:${fillId}:${correctionId}`;
  if (idempotencyKey === `trade.fill:${fillId}`) {
    throw new InvalidEntryError('A fee correction is a new key');
  }

  return {
    idempotencyKey,
    module: 'trade',
    reason: 'trade.fill.fee.correction',
    meta: { fillId, correctionId },
    entries: [
      credit(houseFees('trade', input.assetId), input.difference),
      debit(userAvailable(input.userId, input.assetId), input.difference),
    ],
  };
}

/**
 * An operator cannot change the price or quantity of a posted fill in place.
 * A fee correction is a different post and a new key. This call posts nothing.
 */
export function refusePostedFillPriceEdit(_input: { fillId: string; price?: Amount; qty?: Amount }): never {
  throw new InvalidEntryError('A posted fill price or quantity cannot be changed in place');
}
