import { createHttpLedgerClient, type HttpLedgerOptions, type LedgerClient } from '@intafaced/ledger-client';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

/**
 * Budgets for svc-ledger calls.
 *
 * Where svc-token waits on the ledger, and what is open while it does:
 *
 *   - `post` (stake, unstake, yield sweep and payout, buyback burn, emission mint) is always called with NO database
 *     transaction open: stake, buyback and emission commit their claim row first ("claim-before-post"), unstake commits
 *     its `unstaking` intent first, and yield posts after its plan is claimed. So the post budget protects the caller
 *     (an HTTP job or a bank call waiting on svc-token) and the connection pool, not an idle-in-transaction timer.
 *   - `balance` is called INSIDE open transactions: unstake claim (one read), the yield-window plan (one read per active
 *     stake, under an advisory lock), governance close (one read per active stake, rows locked) and the per-stake
 *     checks. Postgres sees that connection as idle-in-transaction while svc-token waits on HTTP (the shared `createDb`
 *     limit is 60s; svc-token's own pool in `index.ts` sets none, so there is no tighter config to anchor to).
 *
 *   - post: 10s per attempt, 2 retries, 25s for the whole call including backoffs. Retrying a post is safe because the
 *     ledger answers a reused idempotency key with the original transaction (every svc-token key is derived from the
 *     business event: `token.stake:<id>`, `token.emission:<asset>:<epoch>`, `token.burn:...`, `reward:yield:<window>:<user>`), or
 *     refuses a different body (`ledger.idempotency_conflict`).
 *   - reads (`balance`, `balances`, `getTx`, `getTxByKey`): 3s per attempt, 1 retry, 5s for the whole call. A read is
 *     quick when the ledger is well, so a slow one is not worth holding a transaction for.
 *
 * Arithmetic against the 60s limit: Postgres resets the idle timer on every statement, so what matters is the gap
 * between two statements. One read is at most 5s. A loop of reads with no statement between them (the per-stake checks)
 * adds up only while every read SUCCEEDS slowly: the first failure throws at once, so a slow or hung ledger costs the
 * transaction at most 5s of idle time, not N x 5s. Only a ledger answering each read just under its deadline, 12
 * or more times in a row, could pass 60s, and before this client the same loop had no bound at all.
 */
const POST_BUDGET = { timeoutMs: 10_000, retries: 2, deadlineMs: 25_000 } as const;
const READ_BUDGET = { timeoutMs: 3_000, retries: 1, deadlineMs: 5_000 } as const;

/**
 * svc-token's client for svc-ledger: the shared HTTP client, signed as `svc-token`.
 *
 * §2: services never touch another service's tables. svc-token moves a great deal of value (staking, yield, emissions,
 * burns) and every bit of it goes over this client into svc-ledger, which owns the balance graph. It implements the same
 * `LedgerClient` interface the in-memory reference and the Postgres engine implement, so the money paths in
 * `token-service.ts` are written once and tested against the reference without a network.
 *
 * Service credentials (§2): svc-ledger's `post` is a `serviceProcedure`, so this client must prove which service it is.
 * The signature covers a timestamp and the body (L2-6): the shared transport signs the exact bytes it sends, once per
 * attempt, so a captured header stops working after the skew window and cannot be replayed against another stake,
 * unstake or epoch mint.
 *
 * Because it is the shared client, a post returns the entries the ledger actually booked, and `getTx` / `getTxByKey`
 * answer (through the read-only `txById` / `txByKey` doors) instead of throwing "not exposed".
 */
export function createLedgerClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): LedgerClient {
  const shared: Pick<HttpLedgerOptions, 'baseUrl' | 'sign' | 'fetch'> = {
    baseUrl,
    sign: serviceCallSigner({ service: 'svc-token', audience: 'svc-ledger', legacySecret: internalSecret, s2s }),
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
