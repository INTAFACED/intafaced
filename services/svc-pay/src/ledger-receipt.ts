import { LedgerError, type LedgerClient, type LedgerTx, type PostRequest } from '@intafaced/ledger-client';
import { canonicalIdentityOperationIntent } from '@intafaced/contracts';

/** Compact provider ACKs contain no entries. Rich receipts must prove every original leg. */
export async function postPayLedger(ledger: LedgerClient, request: PostRequest): Promise<LedgerTx> {
  return checkPayLedgerReceipt(ledger, request, await ledger.post(request));
}

/** The same proof for a transaction found under the request's key (`getTxByKey`) instead of returned by its post. */
export async function checkPayLedgerReceipt(ledger: LedgerClient, request: PostRequest, tx: LedgerTx): Promise<LedgerTx> {
  const refuse = () => new LedgerError('Ledger acknowledgement does not match the original payment request', 'pay.ledger_receipt_mismatch');
  if (
    !tx ||
    typeof tx.id !== 'string' ||
    !tx.id.trim() ||
    typeof tx.hash !== 'string' ||
    !tx.hash.trim() ||
    !Number.isFinite(tx.postedAt?.getTime()) ||
    tx.idempotencyKey !== request.idempotencyKey ||
    tx.module !== request.module ||
    tx.reason !== request.reason ||
    canonicalIdentityOperationIntent(tx.meta) !== canonicalIdentityOperationIntent(request.meta ?? {}) ||
    !Array.isArray(tx.entries)
  )
    throw refuse();
  if (tx.entries.length === 0) return tx;
  if (tx.entries.length !== request.entries.length) throw refuse();
  const actual = [...tx.entries];
  for (const entry of request.entries) {
    // Only account identity is used. A present-day balance proves no earlier effect.
    const { accountId } = await ledger.balance(entry.account);
    if (!accountId) throw refuse();
    const at = actual.findIndex(
      (posted) =>
        posted.accountId === accountId &&
        posted.assetId === entry.account.assetId &&
        posted.direction === entry.direction &&
        posted.amount === entry.amount &&
        posted.txId === tx.id,
    );
    if (at < 0) throw refuse();
    actual.splice(at, 1);
  }
  return tx;
}
