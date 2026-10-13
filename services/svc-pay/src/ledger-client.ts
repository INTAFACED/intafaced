import { createHttpLedgerClient, type LedgerClient } from '@intafaced/ledger-client';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';

/**
 * Per-attempt and per-call budgets for svc-ledger.
 *
 * `post` is called while a pay transaction is open (capture, the first phase of a refund), so an unbounded retry loop
 * would hold that transaction's row locks and its pool connection for as long as the ledger is unwell. svc-pay sets no
 * statement or idle-in-transaction timeout of its own (the shared `createDb` default idle-in-transaction limit is 60s),
 * so the call is bounded here: each attempt gets 10s, at most 2 retries, and the whole call, backoffs included, stops
 * at 25s. That is under the platform's 60s idle-in-transaction limit, with room for the rest of the transaction.
 * Retrying a post is safe because the ledger answers a reused idempotency key with the original transaction.
 */
const LEDGER_TIMEOUT_MS = 10_000;
const LEDGER_RETRIES = 2;
const LEDGER_DEADLINE_MS = 25_000;

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
export function createLedgerClient(baseUrl: string, internalSecret: string): LedgerClient {
  return createHttpLedgerClient({
    baseUrl,
    sign: (payload) => serviceAuthHeadersForBody('svc-pay', internalSecret, payload),
    timeoutMs: LEDGER_TIMEOUT_MS,
    retries: LEDGER_RETRIES,
    deadlineMs: LEDGER_DEADLINE_MS,
    // Resolved per call, not captured at construction: whatever instruments or replaces the global `fetch` after this
    // client is built (telemetry, a test door) still sees every ledger call.
    fetch: (input, init) => globalThis.fetch(input, init),
  });
}
