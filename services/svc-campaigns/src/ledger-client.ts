import { createHttpLedgerClient, type HttpLedgerOptions, type LedgerClient } from '@intafaced/ledger-client';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

/**
 * svc-campaigns' client for svc-ledger: the shared HTTP client, signed as `svc-campaigns`. It posts two recipes only,
 * `rewardPay` (a claimed task reward, from the one reward pot) and `sweepFeesToRewards` (an approved pot funding), and
 * reads back only its own keys (`getTxByKey`). No database transaction is open around a post (`payouts.ts`).
 *
 *   - post: 10s per attempt, 2 retries, 25s for the whole call. Retrying is safe: the key is the intent's business key,
 *     written with its terms before the first call, so a retry carries the same body and the ledger answers it with the
 *     original transaction.
 *   - reads: 3s per attempt, 1 retry, 5s for the whole call.
 */
const POST_BUDGET = { timeoutMs: 10_000, retries: 2, deadlineMs: 25_000 } as const;
/** No post through this client is still waiting after this long: the reconciler takes a `posting` row only past it. */
export const POST_DEADLINE_SECONDS = Math.ceil(POST_BUDGET.deadlineMs / 1000) + 5;
const READ_BUDGET = { timeoutMs: 3_000, retries: 1, deadlineMs: 5_000 } as const;

export function createLedgerClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): LedgerClient {
  const shared: Pick<HttpLedgerOptions, 'baseUrl' | 'sign' | 'fetch'> = {
    baseUrl,
    sign: serviceCallSigner({ service: 'svc-campaigns', audience: 'svc-ledger', legacySecret: internalSecret, s2s }),
    fetch: (input, init) => globalThis.fetch(input, init),
  };
  const writer = createHttpLedgerClient({ ...shared, ...POST_BUDGET });
  const reader = createHttpLedgerClient({ ...shared, ...READ_BUDGET });

  return {
    post: (request) => writer.post(request),
    balance: (ref) => reader.balance(ref),
    balances: (ownerType, ownerId) => reader.balances(ownerType, ownerId),
    getTx: (txId) => reader.getTx(txId),
    getTxByKey: (idempotencyKey) => reader.getTxByKey(idempotencyKey),
  };
}
