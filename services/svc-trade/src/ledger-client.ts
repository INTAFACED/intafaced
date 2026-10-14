import { createHttpLedgerClient, type HttpLedgerOptions, type LedgerClient } from '@intafaced/ledger-client';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { installPreTradeCredit } from './futures/pretrade-credit.js';
import { installPositionMode } from './futures/position-mode.js';
import { installCollateralHaircut } from './futures/collateral-haircut.js';

/** CARD F5 — index.ts loads this client at boot; mill wraps place/open before hold/lock. */
installPreTradeCredit();
/** CARD F6 — explicit one_way / hedge before futuresMarginLock. */
installPositionMode();
/** CARD F8 — owner haircuts; yield/staked refuse; posted margin is not a loan. */
installCollateralHaircut();

/**
 * Budgets for svc-ledger calls.
 *
 * Until the shared client, svc-trade's own copy had NO timeout at all: one hung ledger held a request, a pooled
 * Postgres connection and (inside a transaction) the row locks for as long as it stayed hung. Now every call is bounded.
 *
 * `post` is called while a trade transaction is open in these places. Postgres sees the connection as idle-in-transaction
 * while trade waits on HTTP, and nothing on the server side bounds that: this service's pool is a raw `postgres()` (see
 * `index.ts`), so the 60s idle-in-transaction limit that `createDb` in packages/db applies does NOT reach it. The
 * client deadlines below are the ONLY bound on how long a row lock is held across a ledger call; 60s is just the
 * ceiling the arithmetic is kept under, as a convention:
 *
 *   - `finalize` (order release) and `applyNativeAmendHold`: one post;
 *   - margin adjust / leverage change (`position-service`): one `balance` read, then one post;
 *   - `closeAtomically` (voluntary futures close): one `balance` read (profit-source bound OR insurance bound, never
 *     both: they are the profit and loss branches), then at most TWO posts (`planClose` emits realise + residual release).
 *
 * The close is the worst case, so it sizes the budget:
 *
 *   - post: 10s per attempt, 2 retries, 20s for the whole call including backoffs. Retrying a post is safe because the
 *     ledger answers a reused idempotency key with the original transaction. The deadline caps the call at about two
 *     slow attempts (the second runs on whatever is left of the 20s); a third attempt only happens after fast 502/503/504s.
 *   - reads (`balance`, `balances`, `getTx`, `getTxByKey`): 3s per attempt, 1 retry, 5s for the whole call. `getTxByKey`
 *     chains to `getTx`, so it can take two reads.
 *
 * Worst case for a close transaction: 5s + 2 x 20s = 45s, under that 60s ceiling with 15s left for SQL. A leverage or
 * margin change: 5s + 20s = 25s. Everything else in a transaction is one post, 20s.
 *
 * Outside a transaction (order placement hold, fills, liquidation rungs, funding, OTC and Convert settle) the same
 * budgets apply; the liquidation tick overlaps are skipped by the job host, and a failed or timed-out rung is replayed
 * from its stored plan on the next tick.
 */
const POST_BUDGET = { timeoutMs: 10_000, retries: 2, deadlineMs: 20_000 } as const;
const READ_BUDGET = { timeoutMs: 3_000, retries: 1, deadlineMs: 5_000 } as const;

/**
 * svc-trade's client for svc-ledger: the shared HTTP client, signed as `svc-trade`.
 *
 * §2: services never touch another service's tables. Every hold, every fill and
 * every release this service performs goes over this client into svc-ledger,
 * which owns the balance graph — this service owns none of it (Doctrine §0.6).
 *
 * It implements the same `LedgerClient` interface the in-memory reference and
 * the Postgres engine implement, so the money paths in `spot/trade-service.ts`
 * are written once and tested against the reference without a network.
 *
 * Auth is body-bound (L2-6): the shared transport serialises once, signs those bytes, sends the same string, and signs
 * again for every retry (fresh timestamp). v1 service-only signatures were replayable against any post body.
 *
 * Because it is the shared client, a post returns the entries the ledger actually booked, and `getTxByKey` (Convert
 * settle asks "was this release / hold / fill already booked?" before it posts) chains `/trpc/txByKey` to
 * `/trpc/txById`, so a found transaction carries its real entries.
 */
export function createLedgerClient(baseUrl: string, internalSecret: string): LedgerClient {
  const shared: Pick<HttpLedgerOptions, 'baseUrl' | 'sign' | 'fetch'> = {
    baseUrl,
    sign: (payload) => serviceAuthHeadersForBody('svc-trade', internalSecret, payload),
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
