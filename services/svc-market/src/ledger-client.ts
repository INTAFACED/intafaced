import { createHttpLedgerClient, type HttpLedgerOptions, type LedgerClient } from '@intafaced/ledger-client';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

/**
 * Budgets for svc-ledger calls.
 *
 * svc-market's money path is `CommerceService.purchase`: the claim row commits, then `marketPurchase` is posted, then the
 * receipt is checked against the ledger (one `balance` lookup per leg, in parallel), then the row is settled. No database
 * transaction is open around any of it: the only transaction in the service (`ensureSubscriptionAccess`) runs after the
 * post and makes no ledger call. So these budgets protect the caller (a buyer's request waiting on svc-market) and the
 * connection pool, not an idle-in-transaction timer. The 60s idle-in-transaction limit (the shared `createDb` default;
 * svc-market's own pool in `index.ts` sets none, so there is no tighter config to anchor to) is not on this path.
 *
 *   - post: 10s per attempt, 2 retries, 25s for the whole call including backoffs. Retrying a post is safe because the
 *     ledger answers a reused idempotency key with the original transaction (`market.purchase:<id>`, with the price and
 *     commission snapshotted on the claim row so a retry never carries another body), or refuses a different body
 *     (`ledger.idempotency_conflict`, which `purchase` maps to `market.purchase_receipt_mismatch`).
 *   - reads (`balance`, `balances`): 3s per attempt, 1 retry, 5s for the whole call. A read is quick when the ledger is
 *     well, so a slow one is not worth holding a buyer's request for.
 *
 * Worst case for a purchase is the post (25s) plus the receipt check (the three leg lookups run in parallel, so 5s), 30s.
 */
const POST_BUDGET = { timeoutMs: 10_000, retries: 2, deadlineMs: 25_000 } as const;
const READ_BUDGET = { timeoutMs: 3_000, retries: 1, deadlineMs: 5_000 } as const;

/**
 * svc-market's client for svc-ledger: the shared HTTP client, signed as `svc-market`.
 *
 * §0.6 / §2: no balances are stored in market; every purchase posts a recipe. It implements the same `LedgerClient`
 * interface the in-memory reference and the Postgres engine implement, so the money path in `commerce-service.ts` is
 * written once and tested against the reference without a network.
 *
 * Service credentials (§2): svc-ledger's `post` is a `serviceProcedure`, so this client must prove which service it is.
 * The signature covers a timestamp and the body (T-04 / L2-6): the shared transport signs the exact bytes it sends, once
 * per attempt, so a captured header stops working after the skew window and cannot be replayed against another purchase.
 *
 * Because it is the shared client, a post returns the entries the ledger actually booked, which is what makes
 * `CommerceService.requireMatchingReceipt` compare real legs instead of being skipped for an empty list (its
 * `tx.entries.length > 0` guard used to be false for every HTTP receipt).
 */
export function createLedgerClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): LedgerClient {
  const shared: Pick<HttpLedgerOptions, 'baseUrl' | 'sign' | 'fetch'> = {
    baseUrl,
    // With a signing key the ledger names this caller from the key; without one the call is signed as it always was.
    sign: serviceCallSigner({ service: 'svc-market', audience: 'svc-ledger', legacySecret: internalSecret, s2s }),
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
    // DELIBERATELY NOT the shared client's lookups, unlike svc-pay. The `txById` / `txByKey` doors do not carry a
    // transaction's `meta`, so a lookup answers `meta: {}`, while `CommerceService.requireMatchingReceipt` refuses any
    // receipt whose meta differs from the `marketPurchase` recipe's (always non-empty: purchaseId, listingId, commission).
    // Wiring the lookups in would turn every resumed purchase (money moved, settle crashed) into a permanent
    // `market.purchase_receipt_mismatch`. Until that check compares only what the door carries, a lookup stays unexposed,
    // exactly as before: `postedMarketPurchase` reads the throw as "unknown", and a resume re-posts under the same key
    // (idempotent) and checks the receipt the POST returns, which does carry the request's meta.
    getTx: async () => {
      throw new Error('getTx is not exposed over the internal ledger API');
    },
    getTxByKey: async () => {
      throw new Error('getTxByKey is not exposed over the internal ledger API');
    },
  };
}
