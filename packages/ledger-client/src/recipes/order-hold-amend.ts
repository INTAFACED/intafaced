import type { Amount } from '../money.js';
import type { AccountRef, EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError } from '../types.js';
import { orderHoldAccount, userAvailable } from '../accounts.js';

const debit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'debit', amount });
const credit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'credit', amount });

export interface OrderHoldAmendInput {
  orderId: string;
  userId: string;
  assetId: string;
  amount: Amount;
  sequence: number;
}

/**
 * Blank, whitespace-only, and missing ids are the same refusal. The original
 * string is what lands in the key — this only rejects an id that trims to empty,
 * before any idempotency key or account ref is built.
 */
function requireAmendId(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidEntryError(`${name} is required for order amend hold`);
  }
  return value;
}

/**
 * Extra size on a live order (native qty-up). Same pot as `orderHold`.
 * Sequence in the key so it never collides with the place hold.
 * Only an integer sequence >= 1 reaches that key. `undefined < 1`, `NaN < 1`,
 * and `Infinity < 1` are all false, so those are refused here with the non-integers.
 */
export function orderHoldAmend(input: OrderHoldAmendInput): PostRequest {
  const orderId = requireAmendId('orderId', input.orderId);
  const userId = requireAmendId('userId', input.userId);
  const assetId = requireAmendId('assetId', input.assetId);
  if (!Number.isInteger(input.sequence) || input.sequence < 1) {
    throw new InvalidEntryError('order amend hold sequence must be an integer >= 1');
  }
  if (input.amount <= 0n) throw new InvalidEntryError('order amend hold amount must be positive');
  return {
    idempotencyKey: `order.hold.amend:${orderId}:${input.sequence}`,
    module: 'trade',
    reason: 'order.hold.amend',
    meta: { orderId, sequence: input.sequence },
    entries: [credit(userAvailable(userId, assetId), input.amount), debit(orderHoldAccount(userId, assetId, orderId), input.amount)],
  };
}
