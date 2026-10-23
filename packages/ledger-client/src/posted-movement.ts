import type { LedgerClient } from './client.js';
import type { LedgerTx, PostRequest } from './types.js';

/**
 * The booked transaction is the request when module, reason, and every leg
 * (account, direction, asset, amount) agree. A detect-mode replay can hand
 * back an older transaction under the same key. That is not this request.
 */
export async function postedRequestMatches(
  ledger: Pick<LedgerClient, 'balance'>,
  tx: LedgerTx,
  request: Pick<PostRequest, 'module' | 'reason' | 'entries'>,
): Promise<boolean> {
  if (tx.module !== request.module || tx.reason !== request.reason) return false;
  if (tx.entries.length !== request.entries.length) return false;
  const used = new Set<number>();
  for (const entry of request.entries) {
    const accountId = (await ledger.balance(entry.account)).accountId;
    if (accountId === '') return false;
    const idx = tx.entries.findIndex(
      (posted, i) =>
        !used.has(i) &&
        posted.accountId === accountId &&
        posted.direction === entry.direction &&
        posted.assetId === entry.account.assetId &&
        posted.amount === entry.amount,
    );
    if (idx < 0) return false;
    used.add(idx);
  }
  return true;
}

/** One greppable line. Reporting a mismatch must not itself throw. */
export function alertLedgerIdempotencyMismatch(info: {
  idempotencyKey: string;
  module: string;
  reason: string;
  ledgerTxId?: string;
  detail: string;
}): void {
  try {
    console.error(JSON.stringify({ level: 'error', service: 'ledger-client', event: 'ledger.idempotency_mismatch', ...info }));
  } catch {
    // The alert is not the refusal. The caller still throws.
  }
}
