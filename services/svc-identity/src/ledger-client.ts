import { createHttpLedgerClient, type LedgerClient } from '@intafaced/ledger-client';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

/**
 * Budget for svc-ledger posts.
 *
 * The affiliate payout (`postAffiliatePayout`) posts a sweep then a payout for each leg of the plan, one after another.
 * The plan is at most `MAX_PAYOUT_TIER_DEPTH` (5) legs, so at most 10 posts. NO database transaction is open around any
 * of them: the plan is read first, the single-use approval is consumed, then the posts run. So the budget protects the
 * caller (an operator's `affiliates.payout` call, or a producer service's best-effort `/internal/affiliate/payout`
 * waiting on identity) and the connection pool, not an idle-in-transaction timer (the shared `createDb` default is 60s;
 * svc-identity's own pool in `index.ts` sets none, so there is no tighter config to anchor to).
 *
 *   - post: 10s per attempt, 2 retries, 25s for the whole call including backoffs. Retrying a post is safe because the
 *     ledger answers a reused idempotency key with the original transaction (every key is derived from the fee event and
 *     the beneficiary row, never from a clock), or refuses a different body (`ledger.idempotency_conflict`).
 *
 * Worst case for a full plan is 10 x 25s, which only a ledger that is down for the whole fan-out reaches; the first post
 * that exhausts its budget throws and stops the fan-out, so a dead ledger costs one 25s budget, not ten. A crash or throw
 * mid-fan-out leaves the tree partially paid, and re-running the same plan completes it paying nobody twice (the keys).
 */
const POST_BUDGET = { timeoutMs: 10_000, retries: 2, deadlineMs: 25_000 } as const;

/**
 * svc-identity's client for svc-ledger: the shared HTTP client, signed as `svc-identity`.
 *
 * §0.6 / §2: svc-identity stores no balances and owns none of the balance graph. The one money path it has is the
 * affiliate / IB fan-out, and it goes over this client into svc-ledger through existing recipes.
 *
 * NARROWER THAN EVERY SIBLING, DELIBERATELY. The other services return a full `LedgerClient`; this returns
 * `Pick<LedgerClient, 'post'>`, because `post` is the entire capability an affiliate payout needs. Handing identity
 * `balance` / `balances` would let a service that must never hold a balance start reading the book, and the narrow type
 * makes that a compile error rather than a code-review question. The shared client's reads are not exposed here.
 *
 * Service credentials (§2, L2-6): the shared transport signs the exact bytes it sends, once per attempt, so a captured
 * header stops working after the skew window and a service-only signature cannot be replayed against another post body.
 *
 * Because it is the shared client, the post returns the entries the ledger actually booked, and a malformed
 * acknowledgement is "outcome unknown" (`svc-ledger invalid post acknowledgement; outcome unknown`), never a success.
 */
export function createLedgerClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): Pick<LedgerClient, 'post'> {
  const writer = createHttpLedgerClient({
    baseUrl,
    sign: serviceCallSigner({ service: 'svc-identity', audience: 'svc-ledger', legacySecret: internalSecret, s2s }),
    // Resolved per call, not captured at construction: whatever instruments or replaces the global `fetch` after this
    // client is built (telemetry, a test door) still sees every ledger call.
    fetch: (input, init) => globalThis.fetch(input, init),
    ...POST_BUDGET,
  });

  return { post: (request) => writer.post(request) };
}
