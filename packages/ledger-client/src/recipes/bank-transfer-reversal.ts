import type { Amount } from '../money.js';
import type { AccountRef, EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError } from '../types.js';
import { accountKey } from '../client.js';
import { BANK_TRANSFER_KEY_SPACES, type BankTransferKeySpace } from './bank.js';

/**
 * CONSENTED REVERSAL OF A POSTED INTERNAL SEND (bank-transfers BK-xfer-09, transfers-payments-068).
 *
 * A posted in-platform send cannot be pulled back by the sender or an operator.
 * It is reversed only when the recipient consents, and then as a new posting
 * that moves the value from the recipient's available account back to the
 * sender's: the original transaction stays in the append-only journal.
 *
 * EVERY INPUT COMES FROM THE STORED TRANSFER ROW. `originalKeySpace`,
 * `transferId`, `occurrence`, `originalFrom`, `originalTo` and `originalAmount`
 * are the original send's own values as svc-bank stored them, never request
 * input. This recipe cannot see the original posting, so it cannot check that
 * those values match one: that is an acceptance test of the svc-bank BK-xfer-09
 * caller. Given them, the reversal key is the original send's identity
 * (`bank.transfer.reverse:<space>:<transferId>:<occurrence>`), so one original
 * send has exactly one reversal, a retried or second consent resolves to it,
 * and `occurrence` is never a free counter (a new occurrence would be a new
 * original send, not a second reversal of the same one).
 *
 * The reversal is whole: `amount` must equal `originalAmount`
 * (`bank.transfer.partial_reversal`). A partial refund is a separate
 * `bankTransfer` under its own refund id (pay ENGINE-SPEC "Not new" row).
 * A recipient who no longer holds the funds is refused by the ledger's
 * non-negative balance and nothing moves.
 */

/** Typed refusals: the code rides on `LedgerError.code`. */
export class BankTransferReversalError extends InvalidEntryError {
  override readonly code: 'bank.transfer.partial_reversal' | 'bank.transfer.consent_missing';
  constructor(code: 'bank.transfer.partial_reversal' | 'bank.transfer.consent_missing', message: string) {
    super(message);
    this.code = code;
    this.name = 'BankTransferReversalError';
  }
}

const debit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'debit', amount });
const credit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'credit', amount });

function requirePositive(name: string, value: unknown): asserts value is Amount {
  if (typeof value !== 'bigint' || value <= 0n) throw new InvalidEntryError(`${name} must be a positive amount`);
}

/** Internal sends only: a rail send is reversed by the rail, not by consent. */
export type BankTransferReversalKeySpace = Exclude<BankTransferKeySpace, 'rail'>;

export interface BankTransferReversalInput {
  /** The original send's key space, from the stored row. */
  originalKeySpace: BankTransferReversalKeySpace;
  /** The original transfer's business id, from the stored row. */
  transferId: string;
  /** The original send's occurrence, from the stored row (0 for a one-off). Not a counter. */
  occurrence: number;
  /** svc-bank's record of the recipient's consent. Required: no consent, no reversal. */
  consentId: string;
  /** The ORIGINAL sender's available account, from the stored row (the value goes back here). */
  originalFrom: AccountRef;
  /** The ORIGINAL recipient's available account, from the stored row (the value leaves here). */
  originalTo: AccountRef;
  /** The original send's amount, from the stored row. */
  originalAmount: Amount;
  /** Must equal `originalAmount`: a reversal is whole. */
  amount: Amount;
}

export function bankTransferReversalKey(space: BankTransferReversalKeySpace, transferId: string, occurrence: number): string {
  if (space === ('rail' as string) || !BANK_TRANSFER_KEY_SPACES.includes(space)) {
    throw new InvalidEntryError(`A consented reversal is for an internal send; key space ${String(space)} is not one`);
  }
  if (typeof transferId !== 'string' || transferId.trim() === '') throw new InvalidEntryError('A reversal needs the original transfer id');
  if (!Number.isInteger(occurrence) || occurrence < 0) {
    throw new InvalidEntryError(`Occurrence must be a non-negative integer, got ${occurrence}`);
  }
  return `bank.transfer.reverse:${space}:${transferId.trim()}:${occurrence}`;
}

export function bankTransferReversal(input: BankTransferReversalInput): PostRequest {
  requirePositive('reversal amount', input.amount);
  requirePositive('original amount', input.originalAmount);
  if (input.amount !== input.originalAmount) {
    throw new BankTransferReversalError(
      'bank.transfer.partial_reversal',
      'A consented reversal moves the whole original amount, never part or more',
    );
  }
  const idempotencyKey = bankTransferReversalKey(input.originalKeySpace, input.transferId, input.occurrence);
  if (typeof input.consentId !== 'string' || input.consentId.trim() === '') {
    throw new BankTransferReversalError(
      'bank.transfer.consent_missing',
      'A reversal of a posted internal send needs the recipient consent id',
    );
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
    meta: {
      keySpace: input.originalKeySpace,
      transferId: input.transferId.trim(),
      occurrence: input.occurrence,
      consentId: input.consentId.trim(),
    },
    entries: [credit(originalTo, input.amount), debit(originalFrom, input.amount)],
  };
}
