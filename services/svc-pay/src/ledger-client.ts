import { createHttpLedgerClient, type HttpLedgerOptions, type LedgerClient } from '@intafaced/ledger-client';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

/**
 * Budgets for svc-ledger calls.
 *
 * `post` is called while a pay transaction is open (capture, the first phase of a refund, payout holds), and Postgres
 * sees that connection as idle-in-transaction while pay waits on HTTP (the shared `createDb` default limit is 60s;
 * svc-pay's own pool sets none, so there is no tighter config to anchor to). An unbounded retry loop would also hold
 * the transaction's row locks for as long as the ledger is unwell. So every call is bounded, and the budgets are sized
 * for the WHOLE `postPayLedger` call, not for one request: a post, then one `balance` lookup per leg, sequentially.
 *
 *   - post: 10s per attempt, 2 retries, 25s for the whole call including backoffs. Retrying a post is safe because the
 *     ledger answers a reused idempotency key with the original transaction.
 *   - reads (`balance`, `balances`, `getTx`, `getTxByKey`): 3s per attempt, 1 retry, 5s for the whole call. A read
 *     is quick when the ledger is well, so a slow one is not worth holding a transaction for.
 *
 * Worst case for `postPayLedger` is 25s + 5s per leg; svc-pay's recipes carry at most 3 legs, so 40s. The refund
 * recovery (a failed post, then `getTxByKey`, which is two reads, then three `balance` lookups) is at most
 * 25s + 2 x 5s + 3 x 5s = 50s. Both stay under 60s with room for the rest of the transaction.
 */
const POST_BUDGET = { timeoutMs: 10_000, retries: 2, deadlineMs: 25_000 } as const;
const READ_BUDGET = { timeoutMs: 3_000, retries: 1, deadlineMs: 5_000 } as const;

/**
 * svc-pay's client for svc-ledger: the shared HTTP client, signed as `svc-pay`.
 *
 * §2: services never touch another service's tables. Every value movement in svc-pay (capture, refund, settlement,
 * payout) goes over this client into svc-ledger, which owns the balance graph. It implements the same `LedgerClient`
 * interface the in-memory reference and the Postgres engine implement, so the money paths in `payment-service.ts` are
 * written once and tested against the reference without a network.
 *
 * Service credentials (§2): svc-ledger's `post` is a `serviceProcedure`, so this client must prove which service it is.
 * The signature covers a timestamp and the body (L2-6): the shared transport signs the exact bytes it sends, once per
 * attempt, so a captured header stops working after the skew window and cannot be replayed against another body.
 *
 * Because it is the shared client, a post returns the entries the ledger actually booked, which is what makes
 * `postPayLedger`'s receipt check compare real legs instead of an empty list.
 */
export function createLedgerClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): LedgerClient {
  const shared: Pick<HttpLedgerOptions, 'baseUrl' | 'sign' | 'fetch'> = {
    baseUrl,
    sign: serviceCallSigner({ service: 'svc-pay', audience: 'svc-ledger', legacySecret: internalSecret, s2s }),
    // Resolved per call, not captured at construction: whatever instruments or replaces the global `fetch` after this
    // client is built (telemetry, a test door) still sees every ledger call.
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
