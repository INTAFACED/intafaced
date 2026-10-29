import { IDEMPOTENCY_CONFLICT_CODE, LedgerError, type LedgerClient, type LedgerTx, type PostRequest } from '@intafaced/ledger-client';
import { MarketError } from '../vendor-service.js';

const mismatch = () => new MarketError('Ledger receipt does not match this purchase', 'market.purchase_receipt_mismatch');

/**
 * The posted transaction is this request: same key, module, reason, meta and legs. Each leg's account id is read from
 * the ledger by its ref, so a receipt for other accounts never passes.
 */
export async function requireMatchingReceipt(ledger: LedgerClient, tx: LedgerTx, request: PostRequest): Promise<void> {
  if (
    !tx.id ||
    tx.idempotencyKey !== request.idempotencyKey ||
    tx.module !== request.module ||
    tx.reason !== request.reason ||
    Object.entries(request.meta ?? {}).some(([key, value]) => tx.meta[key] !== value) ||
    tx.entries.length !== request.entries.length
  ) {
    throw mismatch();
  }
  const expected = await Promise.all(
    request.entries.map(async (entry) => ({
      accountId: (await ledger.balance(entry.account)).accountId,
      assetId: entry.account.assetId,
      direction: entry.direction,
      amount: entry.amount,
    })),
  );
  const actual = [...tx.entries];
  for (const entry of expected) {
    const at = actual.findIndex(
      (posted) =>
        posted.accountId === entry.accountId &&
        posted.assetId === entry.assetId &&
        posted.direction === entry.direction &&
        posted.amount === entry.amount,
    );
    if (at < 0) throw mismatch();
    actual.splice(at, 1);
  }
}

/**
 * Post one recipe and prove the receipt. A reused key with another body (`ledger.idempotency_conflict`) and a receipt
 * for other terms are both `market.purchase_receipt_mismatch`; too little balance is `market.insufficient_funds`, or
 * the caller's own error where the short account is not the buyer's (a held pot). A retry under the same key and body
 * gets the original transaction back, so a lost reply is recovered by posting again.
 */
export async function postWithReceipt(
  ledger: LedgerClient,
  request: PostRequest,
  options: { insufficient?: () => Error } = {},
): Promise<LedgerTx> {
  const tx = await ledger.post(request).catch((error: unknown) => {
    if (error instanceof LedgerError && error.code === IDEMPOTENCY_CONFLICT_CODE) throw mismatch();
    const code = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
    if (code === 'ledger.insufficient_funds') {
      if (options.insufficient) throw options.insufficient();
      throw new MarketError('Insufficient balance for this purchase', 'market.insufficient_funds');
    }
    throw error;
  });
  // Older clients return the original receipt even when this key was used with different terms.
  if (tx.entries.length > 0) await requireMatchingReceipt(ledger, tx, request);
  return tx;
}
