import type { Amount } from '../money.js';
import type { AccountRef, EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError } from '../types.js';
import { userAvailable, userHold } from '../accounts.js';

/**
 * A SEND TO SOMEONE WHO IS NOT A MEMBER YET (PP-send-request-08, J-pay-04).
 *
 * The money is set aside in a pot of the sender's own, one per send
 * (`pay:unclaimed:<sendId>`). It stays the sender's until it is claimed: it never
 * passes through the house, and nobody else's balance moves while it waits.
 *
 *   hold    sender available → sender pot `pay:unclaimed:<sendId>`   (the send)
 *   claim   sender pot       → recipient available                    (the new member claims)
 *   return  sender pot       → sender available                       (cancel or expiry)
 *
 * One outcome per send: claim and return each move the WHOLE pot. The caller
 * passes the amount the send set aside (`heldAmount`) and the recipe refuses any
 * other amount (`PayUnclaimedPartialError`). Once one outcome has emptied the pot
 * the other is refused by the ledger's non-negative balance, so a claim and a
 * cancel at the same moment cannot both post. Cancel and expiry share the one
 * return key: a send is returned once, whatever returned it.
 * Who may claim, the window and the claim link are svc-bank's; these recipes
 * never choose an amount, a recipient or a date.
 */

const debit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'debit', amount });
const credit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'credit', amount });

function requireText(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidEntryError(`${name} is required for a send to someone who is not a member`);
  }
  return value.trim();
}

function requirePositive(name: string, value: Amount): void {
  if (typeof value !== 'bigint' || value <= 0n) throw new InvalidEntryError(`${name} must be positive`);
}

/** The sender's pot for one unclaimed send. */
export function payUnclaimedAccount(senderUserId: string, assetId: string, sendId: string): AccountRef {
  return userHold(
    requireText('senderUserId', senderUserId),
    requireText('assetId', assetId),
    `pay:unclaimed:${requireText('sendId', sendId)}`,
  );
}

export interface PayUnclaimedHoldInput {
  /** Business id of the send (svc-bank's unclaimed-send row). */
  sendId: string;
  /** The member who sent it, and whose pot holds it. */
  senderUserId: string;
  assetId: string;
  amount: Amount;
}

export interface PayUnclaimedOutcomeInput extends PayUnclaimedHoldInput {
  /** The amount `payUnclaimedHold` set aside for this sendId. `amount` must equal it. */
  heldAmount: Amount;
}

export interface PayUnclaimedClaimInput extends PayUnclaimedOutcomeInput {
  /** The new member who claimed it. Never the sender: that is a return. */
  recipientUserId: string;
}

/** A claim or a return must move exactly the amount the send set aside. */
export class PayUnclaimedPartialError extends InvalidEntryError {
  constructor(action: 'claim' | 'return') {
    super(`pay.unclaimed.partial_${action}: an unclaimed send is claimed or returned whole, never in part`);
    this.name = 'PayUnclaimedPartialError';
  }
}

function requireWhole(action: 'claim' | 'return', input: PayUnclaimedOutcomeInput): void {
  requirePositive(`unclaimed ${action} amount`, input.amount);
  requirePositive('held amount', input.heldAmount);
  if (input.amount !== input.heldAmount) throw new PayUnclaimedPartialError(action);
}

function pots(input: PayUnclaimedHoldInput) {
  const sendId = requireText('sendId', input.sendId);
  const senderUserId = requireText('senderUserId', input.senderUserId);
  const assetId = requireText('assetId', input.assetId);
  return {
    sendId,
    senderUserId,
    assetId,
    pot: payUnclaimedAccount(senderUserId, assetId, sendId),
    available: userAvailable(senderUserId, assetId),
  };
}

/** The send: sender available → sender pot `pay:unclaimed:<sendId>`. */
export function payUnclaimedHold(input: PayUnclaimedHoldInput): PostRequest {
  requirePositive('unclaimed send amount', input.amount);
  const p = pots(input);
  return {
    idempotencyKey: `pay.unclaimed.hold:${p.sendId}`,
    module: 'bank',
    reason: 'pay.unclaimed.held',
    meta: { sendId: p.sendId },
    entries: [credit(p.available, input.amount), debit(p.pot, input.amount)],
  };
}

/** The new member claims it: sender pot → recipient available. */
export function payUnclaimedClaim(input: PayUnclaimedClaimInput): PostRequest {
  requireWhole('claim', input);
  const p = pots(input);
  const recipientUserId = requireText('recipientUserId', input.recipientUserId);
  if (recipientUserId === p.senderUserId) {
    throw new InvalidEntryError('A claim goes to the new member; money back to the sender is a return, not a claim');
  }
  return {
    idempotencyKey: `pay.unclaimed.claim:${p.sendId}`,
    module: 'bank',
    reason: 'pay.unclaimed.claimed',
    meta: { sendId: p.sendId, recipientUserId },
    entries: [credit(p.pot, input.amount), debit(userAvailable(recipientUserId, p.assetId), input.amount)],
  };
}

/** Cancelled by the sender, or not claimed in time: sender pot → sender available. */
export function payUnclaimedReturn(input: PayUnclaimedOutcomeInput): PostRequest {
  requireWhole('return', input);
  const p = pots(input);
  return {
    idempotencyKey: `pay.unclaimed.return:${p.sendId}`,
    module: 'bank',
    reason: 'pay.unclaimed.returned',
    meta: { sendId: p.sendId },
    entries: [credit(p.pot, input.amount), debit(p.available, input.amount)],
  };
}
