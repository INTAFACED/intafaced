import { createHttpLedgerClient, type HttpLedgerOptions, type LedgerClient } from '@intafaced/ledger-client';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

/**
 * Budgets for svc-ledger calls.
 *
 * svc-agents moves value in exactly one place: `UsageMeter.settleInner` posts the `feeCharge` for a sealed usage window.
 * That post is made with NO database transaction open: the seal commits first (it freezes the amount and the charge key),
 * and the ledger id is written back by a plain statement afterwards. So the post budget protects the caller (a settle
 * route or `session.close` waiting on svc-agents) and the connection pool, not an idle-in-transaction timer. It reads one
 * balance: the person's available amount before a run is admitted (`funds` in `index.ts`), read inside the spend
 * reservation's transaction under the per-user lock, so the read budget below bounds how long that lock is held.
 *
 *   - post: 10s per attempt, 2 retries, 25s for the whole call including backoffs. Retrying a post is safe because the
 *     ledger answers a reused idempotency key with the original transaction (the key is the window's charge key,
 *     `fee:<module>:<session>:<window>`, fixed when the window is sealed), or refuses a different body
 *     (`ledger.idempotency_conflict`). A sealed amount never changes, so a retry cannot carry a different body.
 *   - reads (`balance`, `balances`, `getTx`, `getTxByKey`): 3s per attempt, 1 retry, 5s for the whole call.
 *
 * The 60s idle-in-transaction limit (the shared `createDb` default; svc-agents' own pool in `index.ts` sets none, so there
 * is no tighter config to anchor to) is not on this path. If a transaction is ever opened around a post, 25s leaves 35s
 * for everything else in it.
 */
const POST_BUDGET = { timeoutMs: 10_000, retries: 2, deadlineMs: 25_000 } as const;
const READ_BUDGET = { timeoutMs: 3_000, retries: 1, deadlineMs: 5_000 } as const;

/**
 * svc-agents' client for svc-ledger: the shared HTTP client, signed as `svc-agents`.
 *
 * §2: services never touch another service's tables. Settling a metered usage window goes over this client into
 * svc-ledger, which owns the balance graph (Doctrine §0.6). It implements the same `LedgerClient` interface the
 * in-memory reference and the Postgres engine implement, so the metering path in `metering/meter.ts` is written once and
 * tested against the reference without a network.
 *
 * Service credentials (§2): svc-ledger's `post` is a `serviceProcedure`, so this client must prove which service it is.
 * The signature covers a timestamp and the body (L2-6): the shared transport signs the exact bytes it sends, once per
 * attempt, so a captured header stops working after the skew window and cannot be replayed against another charge.
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
    sign: serviceCallSigner({ service: 'svc-agents', audience: 'svc-ledger', legacySecret: internalSecret, s2s }),
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
