import type { Amount } from '../money.js';
import type { AccountRef, EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError } from '../types.js';
import { accountKey } from '../client.js';

/**
 * CONSENTED REVERSAL OF A POSTED INTERNAL SEND (bank-transfers BK-xfer-09, transfers-payments-068).
 *
 * A posted in-platform send cannot be pulled back by the sender or an operator.
 * It is reversed only when the recipient consents, and then as a new posting
 * that moves the value from the recipient's available account back to the
 * sender's: the original transaction stays in the append-only journal.
 *
 * One reversal per original firing: the key is
 * `bank.transfer.reverse:<transferId>:<occurrence>`, so a retried or doubled
 * consent posts once. The amount is the caller's (svc-bank checks it against
 * the original and records the consent); a recipient who no longer holds the
 * funds is refused by the ledger's non-negative balance and nothing moves.
 */

const debit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'debit', amount });
const credit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'credit', amount });

export interface BankTransferReversalInput {
  /** The original transfer's business id. */
  transferId: string;
  /** The original transfer's occurrence (0 for a one-off). */
  occurrence: number;
  /** svc-bank's record of the recipient's consent. Required: no consent, no reversal. */
  consentId: string;
  /** The ORIGINAL sender's available account (the value goes back here). */
  originalFrom: AccountRef;
  /** The ORIGINAL recipient's available account (the value leaves here). */
  originalTo: AccountRef;
  amount: Amount;
}

export function bankTransferReversalKey(transferId: string, occurrence: number): string {
  if (typeof transferId !== 'string' || transferId.trim() === '') throw new InvalidEntryError('A reversal needs the original transfer id');
  if (!Number.isInteger(occurrence) || occurrence < 0) {
    throw new InvalidEntryError(`Occurrence must be a non-negative integer, got ${occurrence}`);
  }
  return `bank.transfer.reverse:${transferId.trim()}:${occurrence}`;
}

export function bankTransferReversal(input: BankTransferReversalInput): PostRequest {
  if (typeof input.amount !== 'bigint' || input.amount <= 0n) throw new InvalidEntryError('reversal amount must be positive');
  const idempotencyKey = bankTransferReversalKey(input.transferId, input.occurrence);
  if (typeof input.consentId !== 'string' || input.consentId.trim() === '') {
    throw new InvalidEntryError('A reversal of a posted internal send needs the recipient consent id');
  }
  const { originalFrom, originalTo } = input;
  if (originalFrom.assetId !== originalTo.assetId) throw new InvalidEntryError('A reversal cannot change asset');
  if (accountKey(originalFrom) === accountKey(originalTo)) throw new InvalidEntryError('A reversal must have two different accounts');
  if (originalFrom.kind !== 'available' || originalTo.kind !== 'available') {
    throw new InvalidEntryError('A reversal moves between available accounts only');
  }
  return {
    idempotencyKey,
    module: 'bank',
    reason: 'bank.transfer.reversed',
    meta: { transferId: input.transferId.trim(), occurrence: input.occurrence, consentId: input.consentId.trim() },
    entries: [credit(originalTo, input.amount), debit(originalFrom, input.amount)],
  };
}
