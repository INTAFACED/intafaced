import { bankTransferIdempotencyKey, railBoundary, type AccountRef, type Amount, type LedgerClient, type LedgerTx } from '@intafaced/ledger-client';
import { postBankTransfer } from '../transfers/book-bank-transfer.js';

/**
 * Move a space's available balance to a named rail boundary, or back.
 *
 * Occurrence 0 is the send. Occurrence 1 is the reversal when the rail
 * then refuses. Both keys are the payment id, so a retry posts nothing new.
 * The rail id comes from the injected port. This file does not pick a partner.
 */

export async function postToRail(
  ledger: LedgerClient,
  transferId: string,
  from: AccountRef,
  railId: string,
  amount: Amount,
): Promise<LedgerTx> {
  return postBankTransfer(ledger, {
    transferId,
    occurrence: 0,
    from,
    to: railBoundary(railId, from.assetId),
    amount,
    kind: 'manual',
    lane: 'rail',
  });
}

export async function reverseFromRail(
  ledger: LedgerClient,
  transferId: string,
  to: AccountRef,
  railId: string,
  amount: Amount,
): Promise<LedgerTx> {
  return postBankTransfer(ledger, {
    transferId,
    occurrence: 1,
    from: railBoundary(railId, to.assetId),
    to,
    amount,
    kind: 'manual',
    lane: 'rail',
  });
}

export function forwardKey(transferId: string): string {
  return bankTransferIdempotencyKey('rail', transferId, 0);
}
