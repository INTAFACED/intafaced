import type { AccountRef, Amount, LedgerClient, LedgerTx } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';

/**
 * The booked transaction is this movement only when it is the `bankTransfer` pair: the source account credited and the
 * destination debited by exactly `amount`, and no other leg.
 *
 * A ledger in `detect` mode answers a reused key with the ORIGINAL transaction even when this body differs. Only the
 * transaction's own entries say what actually moved, so a caller that is about to record a send as booked reads them.
 */
export async function bookedTransferMatches(
  ledger: Pick<LedgerClient, 'balance' | 'getTx'>,
  receipt: Pick<LedgerTx, 'id' | 'entries'>,
  from: AccountRef,
  to: AccountRef,
  amount: Amount,
): Promise<boolean> {
  // An older svc-ledger may answer a post with no entries on the receipt. Only the transaction itself says what moved.
  const tx = receipt.entries.length > 0 ? receipt : await ledger.getTx(receipt.id);
  if (tx === null || tx.entries.length !== 2) return false;
  const fromAccountId = (await ledger.balance(from)).accountId;
  const toAccountId = (await ledger.balance(to)).accountId;
  if (fromAccountId === '' || toAccountId === '') return false;
  const credit = tx.entries.find(
    (entry) =>
      entry.direction === 'credit' && entry.accountId === fromAccountId && entry.assetId === from.assetId && entry.amount === amount,
  );
  const debit = tx.entries.find(
    (entry) => entry.direction === 'debit' && entry.accountId === toAccountId && entry.assetId === to.assetId && entry.amount === amount,
  );
  return credit !== undefined && debit !== undefined;
}

/**
 * The ledger answered a post with a transaction that is not the movement we sent. Something else is booked under the
 * key, so the outcome of THIS send is unknown: callers must keep their claim and never treat this as a refusal.
 */
export class BookedTransferConflict extends BankError {
  constructor(transferId: string) {
    super(
      `Transfer ${transferId} is already booked as a different movement (bank.personal_transfer_conflict)`,
      'bank.personal_transfer_conflict',
    );
  }
}
