import type { Amount } from '../money.js';
import type { AccountRef, EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError } from '../types.js';
import { userAvailable, userHold } from '../accounts.js';

/**
 * HOLDS ON RECEIVED FUNDS (pay ENGINE-SPEC section 2, RH-1 to RH-4; slice PP-money-balance-05).
 *
 * A hold on money a user received is a ledger hold in a pot of its own per hold
 * (`pay:recv:<holdId>`), owned by the recipient. It limits only what the
 * recipient can spend or cash out; it never moves value to the house.
 *
 *   hold     recipient available → recipient hold `pay:recv:<holdId>`
 *   release  recipient hold      → recipient available    (release date or early by an agent)
 *   return   recipient hold      → payer available        (a ruling returns it to the payer)
 *
 * Release and return draw on the same pot, so once one has emptied it the other
 * is refused by the ledger's non-negative hold balance: one outcome per hold.
 * Who may place a hold, the reason class and the release date are svc-bank's
 * (owner rule table); these recipes never choose an amount or a date.
 */

const debit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'debit', amount });
const credit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'credit', amount });

function requireText(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidEntryError(`${name} is required for a hold on received funds`);
  }
  return value.trim();
}

function requirePositive(name: string, value: Amount): void {
  if (typeof value !== 'bigint' || value <= 0n) throw new InvalidEntryError(`${name} must be positive`);
}

/** The recipient's pot for one hold on received funds. */
export function payReceivedHoldAccount(userId: string, assetId: string, holdId: string): AccountRef {
  return userHold(userId, assetId, `pay:recv:${holdId}`);
}

export interface PayReceivedHoldInput {
  /** Business id of the hold (svc-bank's hold row). */
  holdId: string;
  /** The recipient whose received funds are held. */
  userId: string;
  assetId: string;
  amount: Amount;
}

export interface PayReceivedReturnInput extends PayReceivedHoldInput {
  /** The payer the ruling returns the held funds to. */
  payerUserId: string;
}

function pots(input: PayReceivedHoldInput) {
  const holdId = requireText('holdId', input.holdId);
  const userId = requireText('userId', input.userId);
  const assetId = requireText('assetId', input.assetId);
  return { holdId, userId, assetId, hold: payReceivedHoldAccount(userId, assetId, holdId), available: userAvailable(userId, assetId) };
}

/** Place a hold: recipient available → recipient hold `pay:recv:<holdId>`. */
export function payReceivedHold(input: PayReceivedHoldInput): PostRequest {
  requirePositive('received-funds hold amount', input.amount);
  const p = pots(input);
  return {
    idempotencyKey: `pay.recv.hold:${p.holdId}`,
    module: 'bank',
    reason: 'pay.recv.held',
    meta: { holdId: p.holdId },
    entries: [credit(p.available, input.amount), debit(p.hold, input.amount)],
  };
}

/** Release a hold to the recipient: recipient hold → recipient available. */
export function payReceivedRelease(input: PayReceivedHoldInput): PostRequest {
  requirePositive('received-funds release amount', input.amount);
  const p = pots(input);
  return {
    idempotencyKey: `pay.recv.release:${p.holdId}`,
    module: 'bank',
    reason: 'pay.recv.released',
    meta: { holdId: p.holdId },
    entries: [credit(p.hold, input.amount), debit(p.available, input.amount)],
  };
}

/** A ruling returns held funds to the payer: recipient hold → payer available. */
export function payReceivedReturn(input: PayReceivedReturnInput): PostRequest {
  requirePositive('received-funds return amount', input.amount);
  const p = pots(input);
  const payerUserId = requireText('payerUserId', input.payerUserId);
  if (payerUserId === p.userId) {
    throw new InvalidEntryError('A return goes to the payer; the recipient is released, not returned to');
  }
  return {
    idempotencyKey: `pay.recv.return:${p.holdId}`,
    module: 'bank',
    reason: 'pay.recv.returned',
    meta: { holdId: p.holdId, payerUserId },
    entries: [credit(p.hold, input.amount), debit(userAvailable(payerUserId, p.assetId), input.amount)],
  };
}
