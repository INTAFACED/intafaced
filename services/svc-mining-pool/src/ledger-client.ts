import { createHttpLedgerClient, type LedgerClient } from '@intafaced/ledger-client';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

/**
 * Budget for svc-ledger posts.
 *
 * NOTHING POSTS TODAY. `postPayouts` builds the PPLNS recipes and then refuses (`mining.emission_unpublished`) before it
 * touches the ledger, so this client is wired and signed but unreachable from a payout until the owner publishes emission
 * law. The budget is set for the shape the call will have when it is: `payWindow` runs `postPayouts` INSIDE its database
 * transaction, holding `FOR UPDATE` on the window row, with one post per payout and no statement between them. Postgres
 * sees that connection as idle-in-transaction while the pool waits on HTTP (the shared `createDb` default limit is 60s;
 * this service's own pool in `server.ts` is a bare `postgres()` with none, so there is no tighter config to anchor to).
 *
 *   - post: 10s per attempt, 2 retries, 25s for the whole call including backoffs. Retrying a post is safe because the
 *     ledger answers a reused idempotency key with the original transaction (`reward:mining:pplns:<window>:<miner>`), or
 *     refuses a different body (`ledger.idempotency_conflict`).
 *
 * Arithmetic against the 60s limit: the idle timer only runs while no statement does, and the first post that fails
 * throws, which rolls the transaction back, so an outage costs the transaction one post budget (25s), not one per payout.
 * Healthy posts take milliseconds. What the budget does NOT cover is a ledger that answers every post just under its
 * deadline for three or more payouts in a row (3 x 25s > 60s): when payouts are wired, post them outside the window's
 * transaction (claim, commit, post by key, mark paid) rather than rely on this bound. Before this client, the post had no
 * timeout at all, so a hung ledger held the window row, the connection, and the job host's `running` flag forever.
 */
const POST_BUDGET = { timeoutMs: 10_000, retries: 2, deadlineMs: 25_000 } as const;

/**
 * The pool writes only through svc-ledger; it never owns a balance. The shared HTTP client, signed as `svc-mining-pool`.
 *
 * Narrow on purpose: payouts post, and a payout read looks up the transaction the
 * payout job booked (`getTxByKey` on `reward:mining:pplns:<window>:<miner>`).
 * `balance` and `balances` stay unexposed. The pool does not hold a book.
 *
 * Service credentials (§2, L2-6): the shared transport signs the exact bytes it sends, once per attempt, so a captured
 * header stops working after the skew window and cannot be replayed against another post body.
 *
 * ERRORS ARE TYPED NOW. A failed post used to throw `Error('mining.ledger_post_failed:<status>')`, which dropped the
 * ledger's own reason. It now throws what the shared client throws: a `LedgerError` carrying the ledger's code
 * (`ledger.insufficient_funds` as `InsufficientFundsError`, `ledger.frozen`, `ledger.idempotency_conflict`, ...), or
 * `svc-ledger /trpc/post failed (<status>): <detail>` when the answer had no code, or `svc-ledger invalid post
 * acknowledgement; outcome unknown` for a malformed success. Nothing in the repo reads the old string: `runEpochPayoutTick`
 * keys only on `mining.epoch_unset` and `mining.emission_unpublished` and rethrows everything else to the job host's
 * `onError`, as before.
 */
export function createLedgerClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): Pick<LedgerClient, 'post' | 'getTxByKey'> {
  const writer = createHttpLedgerClient({
    baseUrl,
    sign: serviceCallSigner({ service: 'svc-mining-pool', audience: 'svc-ledger', legacySecret: internalSecret, s2s }),
    // Resolved per call, not captured at construction: whatever instruments or replaces the global `fetch` after this
    // client is built (telemetry, a test door) still sees every ledger call.
    fetch: (input, init) => globalThis.fetch(input, init),
    ...POST_BUDGET,
  });

  return {
    post: (request) => writer.post(request),
    getTxByKey: (idempotencyKey) => writer.getTxByKey(idempotencyKey),
  };
}
