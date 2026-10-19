import {
  createHttpLedgerClient,
  createLedgerTransport,
  formatAmount,
  parseAmount,
  type AccountRef,
  type HttpLedgerOptions,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import type { HistoryRange, LedgerEntryRecord, LedgerHistory } from './analytics/ledger-history.js';
import type { LedgerHistoryPages, LedgerPageRequest } from './activity/activity-service.js';

/**
 * Budgets for svc-ledger calls.
 *
 * `post` is called while a bank transaction is open in places (`earn.withdraw` reads the stake pot and posts inside one;
 * a scheduled transfer's firing posts, or on a refused space looks the key up, inside its claim transaction), and
 * Postgres sees that connection as idle-in-transaction while bank waits on HTTP. Other posts run under a session
 * advisory lock on a reserved pool connection (loan repay and liquidation, the off-ramp), which is held, not idle in a
 * transaction, but starves the pool just the same. An unbounded retry loop would hold the lock, or the row locks, for as
 * long as the ledger is unwell, so every call is bounded.
 *
 * svc-bank builds its own `postgres()` pool (index.ts) and sets no `idle_in_transaction_session_timeout` or
 * `statement_timeout`, so nothing in this service enforces the 60s that `createDb` in `packages/db` defaults to. That
 * number is the project's published safety bound, though, so the arithmetic below is anchored to it.
 *
 *   - post: 10s per attempt, 2 retries, 25s for the whole call including backoffs. Retrying a post is safe because the
 *     ledger answers a reused idempotency key with the original transaction.
 *   - reads (`balance`, `balances`, `getTx`, `getTxByKey`): 3s per attempt, 1 retry, 5s for the whole call. A read is
 *     quick when the ledger is well, so a slow one is not worth holding a transaction or a connection for.
 *     `getTxByKey` is two reads (txByKey, then txById), each with its own 5s.
 *   - history reads (`entriesFor`, one `historyPage`): 8s per attempt, 1 retry, 12s for the call. They scan a range of the
 *     book rather than look up one row, and they run in a request handler with no transaction open, so they get a more
 *     patient budget than a lookup but are still bounded.
 *
 * Worst cases for the chains that hold a transaction open:
 *   - `earn.withdraw`: one stake-pot `balance` then the post = 5s + 25s = 30s.
 *   - a scheduled transfer firing: the post (25s), or on a refused space two reads for `getTxByKey` (10s); not both.
 *   - the interest accrual's claim step reads one stake pot per active position, sequentially, inside its transaction:
 *     5s per position in the worst case. That scales with the pool and is out of scope here (it is the same shape that
 *     was unbounded before this client had any deadline), but it is the one chain that can pass 60s if the ledger is down
 *     and the pool is large; a healthy ledger answers each in milliseconds.
 * The longest chain that holds a reserved connection is the off-ramp's hold then settle, 2 x 25s = 50s.
 */
const POST_BUDGET = { timeoutMs: 10_000, retries: 2, deadlineMs: 25_000 } as const;
const READ_BUDGET = { timeoutMs: 3_000, retries: 1, deadlineMs: 5_000 } as const;
const HISTORY_BUDGET = { timeoutMs: 8_000, retries: 1, deadlineMs: 12_000 } as const;

/** What every svc-bank call shares: where, who is calling (signed over the exact bytes), and a per-call `fetch`. */
/** Own-key signing (S2S v3). Unset: every call is signed with the shared secret as before. */
export type LedgerS2s = { signer: ServiceSigner; mode: ServiceAuthMode };

function sharedOptions(baseUrl: string, internalSecret: string, s2s?: LedgerS2s): Pick<HttpLedgerOptions, 'baseUrl' | 'sign' | 'fetch'> {
  return {
    baseUrl,
    // Body-bound service credentials (T-04 / L2-6). svc-ledger's `post` is a `serviceProcedure`; signing identity and
    // timestamp alone left a captured signature replayable against ANY body for ~300s. The shared transport signs the
    // exact bytes it sends, once per attempt, so a retry carries a fresh timestamp.
    sign: serviceCallSigner({ service: 'svc-bank', audience: 'svc-ledger', legacySecret: internalSecret, s2s }),
    // Resolved per call, not captured at construction: whatever instruments or replaces the global `fetch` after this
    // client is built (telemetry, a test door) still sees every ledger call.
    fetch: (input, init) => globalThis.fetch(input, init),
  };
}

/**
 * svc-bank's client for svc-ledger: the shared HTTP client, signed as `svc-bank`.
 *
 * §2: services never touch another service's tables. Every movement svc-bank makes (a transfer between spaces, an earn
 * deposit, a day's interest) goes over this client into svc-ledger, which owns the balance graph.
 *
 * It implements the same `LedgerClient` interface the in-memory reference and the Postgres engine implement, so the
 * money paths in this service are written once and tested against the reference without a network.
 *
 * Because it is the shared client, a post returns the entries the ledger actually booked, and `getTxByKey` returns the
 * real entries too (it chains to `/trpc/txById`), so receipt checks such as `postedPayrollMatches` compare real legs.
 */
export function createLedgerClient(baseUrl: string, internalSecret: string, s2s?: LedgerS2s): LedgerClient {
  const shared = sharedOptions(baseUrl, internalSecret, s2s);
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

/**
 * Spend-analytics adapter over svc-ledger's `/trpc/history`.
 *
 * §13 SOCKET (honesty): it deliberately does not fall back to an empty result when the ledger is down or the procedure
 * is missing: a spend view that silently reports zero is worse than one that is unavailable, because the user cannot
 * tell "you spent nothing" from "we could not ask". A failure is thrown.
 *
 * Reads are service-to-service too: same signing and transport as every other call here, so a read client that cannot
 * identify itself does not need changing the moment the procedure becomes a `serviceProcedure`.
 */
export function createLedgerHistory(baseUrl: string, internalSecret: string, s2s?: LedgerS2s): LedgerHistory {
  const call = createLedgerTransport({ ...sharedOptions(baseUrl, internalSecret, s2s), ...HISTORY_BUDGET });

  return {
    async entriesFor(account: AccountRef, range: HistoryRange): Promise<LedgerEntryRecord[]> {
      const result = await call<
        Array<{ txId: string; module: string; reason: string; direction: 'debit' | 'credit'; amount: string; postedAt: string }>
      >('/trpc/history', { account, from: range.from.toISOString(), to: range.to.toISOString() });

      return result.map((e) => ({
        txId: e.txId,
        module: e.module,
        reason: e.reason,
        direction: e.direction,
        amount: parseAmount(e.amount),
        postedAt: new Date(e.postedAt),
      }));
    },
  };
}

/**
 * Paged history adapter for `bank.activity.list` — svc-ledger `/trpc/historyPage`.
 *
 * Same service credential and body-bound signing as every other call here. The ledger's schema is strict: this sends
 * exactly `{ownerType, ownerId, kind, assetId?, limit, cursor?}` and never `purpose`, `before` or anything else. A
 * failure is thrown, never turned into an empty page: "no activity" and "we could not ask" must not look alike.
 */
export function createLedgerHistoryPages(baseUrl: string, internalSecret: string, s2s?: LedgerS2s): LedgerHistoryPages {
  const call = createLedgerTransport({ ...sharedOptions(baseUrl, internalSecret, s2s), ...HISTORY_BUDGET });

  return {
    async page(request: LedgerPageRequest) {
      const body = {
        ownerType: request.ownerType,
        ownerId: request.ownerId,
        kind: request.kind,
        ...(request.assetId === undefined ? {} : { assetId: request.assetId }),
        limit: request.limit,
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      };
      const result = await call<{
        entries: Array<{
          txId: string;
          module: string;
          reason: string;
          direction: 'debit' | 'credit';
          amount: string;
          postedAt: string;
          assetId: string;
          entryId?: string;
          rail?: string | null;
          orderId?: string | null;
        }>;
        nextCursor: string | null;
      }>('/trpc/historyPage', body);

      return {
        entries: result.entries.map((e) => ({
          txId: e.txId,
          module: e.module,
          reason: e.reason,
          direction: e.direction,
          // Round-trip through the scaled bigint so a malformed amount is refused here, not shown.
          amount: formatAmount(parseAmount(e.amount)),
          postedAt: new Date(e.postedAt),
          assetId: e.assetId,
          // Both arrive with svc-ledger's entry-id change; absent before it, and the feed copes.
          ...(typeof e.entryId === 'string' && /^\d{1,19}$/.test(e.entryId) ? { entryId: e.entryId } : {}),
          ...(typeof e.rail === 'string' || e.rail === null ? { rail: e.rail } : {}),
          // The page owner's own order id (trade lines only). Absent from an older ledger; null or absent = none.
          ...(typeof e.orderId === 'string' && e.orderId !== '' ? { orderId: e.orderId } : {}),
        })),
        nextCursor: result.nextCursor,
      };
    },
  };
}
