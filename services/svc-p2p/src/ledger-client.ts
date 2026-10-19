import {
  createHttpLedgerClient,
  parseAmount,
  InsufficientFundsError,
  type AccountRef,
  type HttpLedgerOptions,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

/**
 * Budgets for svc-ledger calls.
 *
 * `post` of `escrowLock` runs while a p2p transaction is open (`ensureEscrowed`: the trade row is locked FOR UPDATE and
 * Postgres sees the connection as idle-in-transaction while p2p waits on HTTP; this service's own pool sets no idle
 * bound, so the 60s `createDb` default in packages/db is the budget to stay under). The release and refund posts in
 * `settle`, and the reads (`escrowIntegrity`), run outside a transaction.
 *
 *   - post: 15s per attempt and NO retry. This is not the svc-pay budget on purpose. p2p counts every remote
 *     invocation: `claimEscrowLockAttempt` commits an intent row BEFORE each dispatch, and a definitive funds refusal only
 *     voids a trade when that was the first and only attempt (a timed-out earlier attempt may still post). A retry inside
 *     the client would be a second invocation the service never claimed, so a timed-out first attempt that later lands
 *     could be followed by a retry's funds refusal and the trade voided with its escrow locked. The sweep re-drives with
 *     a claim instead, which is the existing retry.
 *   - reads (`balance`, `balances`, `getTx`, `getTxByKey`): 3s per attempt, 1 retry, 5s for the whole call. A read is
 *     idempotent, so it may retry.
 *
 * Worst case for the lock transaction: 15s for the post, plus, only when the ledger refused for funds, one identity
 * `balance` read of at most 5s = 20s. Under the 60s bound with 40s left for SQL.
 *
 * `options.timeoutMs` replaces the per-attempt budget of both clients (a read stays capped by its 5s deadline).
 */
const POST_TIMEOUT_MS = 15_000;
const READ_BUDGET = { timeoutMs: 3_000, retries: 1, deadlineMs: 5_000 } as const;

/**
 * HTTP client for svc-ledger: the shared client, signed as `svc-p2p`.
 *
 * §2: services never touch another service's tables. Every unit of P2P escrow
 * goes over this client into svc-ledger, which owns the balance graph —
 * svc-p2p holds no balances at all (Doctrine §0.6).
 *
 * It implements the same `LedgerClient` interface as `MemoryLedger`, which the
 * conformance suite proves equivalent to svc-ledger's Postgres engine (§4.4).
 * That equivalence is why the escrow money paths can be tortured in tests
 * without a network and still mean something.
 *
 * Service credentials (§2): svc-ledger's `post` is a `serviceProcedure`, so this client must prove which service it is.
 * The signature covers a timestamp and the body (L2-6): the shared transport signs the exact bytes it sends, once per
 * attempt, so a captured header stops working after the skew window and cannot be replayed against another body.
 */
export function createLedgerClient(
  baseUrl: string,
  internalSecret: string,
  options: { timeoutMs?: number; s2s?: { signer: ServiceSigner; mode: ServiceAuthMode } } = {},
): LedgerClient {
  // Transport budget only: neither an escrow deadline nor a ledger outcome.
  // Node timers overflow above this bound; never silently disable the budget.
  const { timeoutMs, s2s } = options;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)) {
    throw new RangeError('P2P ledger HTTP timeoutMs must be a positive integer at most 2147483647');
  }
  const shared: Pick<HttpLedgerOptions, 'baseUrl' | 'sign' | 'fetch'> = {
    baseUrl,
    sign: serviceCallSigner({ service: 'svc-p2p', audience: 'svc-ledger', legacySecret: internalSecret, s2s }),
    // Resolved per call, not captured at construction: whatever instruments or replaces the global `fetch` after this
    // client is built (telemetry, a test door) still sees every ledger call.
    fetch: (input, init) => globalThis.fetch(input, init),
  };
  const reader = createHttpLedgerClient({ ...shared, ...READ_BUDGET, timeoutMs: timeoutMs ?? READ_BUDGET.timeoutMs });

  const unknown = () => new Error('svc-ledger incomplete or inconsistent funds refusal; outcome unknown');

  /**
   * Rehydrate a typed funds failure so p2p-service's void-on-failed-lock runs in production (MemoryLedger tests already
   * throw InsufficientFundsError). A funds refusal is only DEFINITIVE when the wire body is complete and consistent and
   * the ledger agrees on the credited account; anything less is an unknown outcome, never a refusal.
   *
   * `request` is the WIRE body the shared transport sent (`entries[].amount` are decimal strings), not the original
   * `PostRequest`.
   */
  async function definitiveFundsRefusal(detail: string, request: unknown): Promise<InsufficientFundsError> {
    let raw: unknown;
    try {
      raw = JSON.parse(detail);
    } catch {
      throw unknown();
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw unknown();
    const { code, message, accountId, assetId, requested, availableBalance } = raw as Record<string, unknown>;
    if (
      code !== 'ledger.insufficient_funds' ||
      typeof message !== 'string' ||
      !message.trim() ||
      typeof accountId !== 'string' ||
      accountId !== accountId.trim() ||
      typeof assetId !== 'string' ||
      !assetId ||
      typeof requested !== 'string' ||
      requested !== requested.trim() ||
      typeof availableBalance !== 'string' ||
      availableBalance !== availableBalance.trim()
    )
      throw unknown();
    let needed: ReturnType<typeof parseAmount>;
    let available: ReturnType<typeof parseAmount>;
    try {
      needed = parseAmount(requested);
      available = parseAmount(availableBalance);
    } catch {
      throw unknown();
    }
    if (needed <= 0n || available < 0n || available >= needed) throw unknown();
    const mentioned = /Insufficient (\S+): requested (\S+), available (\S+)/.exec(message);
    if (mentioned) {
      try {
        if (mentioned[1] !== assetId || parseAmount(mentioned[2]!) !== needed || parseAmount(mentioned[3]!) !== available) throw unknown();
      } catch {
        throw unknown();
      }
    }
    const entries = (request as { entries?: unknown } | null)?.entries;
    if (!Array.isArray(entries)) throw unknown();
    const credits = entries.filter((entry: { direction?: unknown; account?: { assetId?: unknown }; amount?: unknown }) => {
      if (entry?.direction !== 'credit' || entry.account?.assetId !== assetId || typeof entry.amount !== 'string') return false;
      try {
        return parseAmount(entry.amount) === needed;
      } catch {
        return false;
      }
    });
    if (credits.length !== 1) throw unknown();
    // Account IDs are opaque. The published balance read is side-effect-free;
    // only identity is compared, never its current amount as no-effect proof.
    let identity: Awaited<ReturnType<LedgerClient['balance']>>;
    try {
      identity = await reader.balance((credits[0] as { account: AccountRef }).account);
    } catch {
      throw unknown();
    }
    // The shared read already validated the existing read envelope (string id, parseable amount) without treating the
    // amount as post evidence; only identity is compared. Explicit '' is the published absent-account identity, only
    // when this read agrees.
    if (identity.accountId !== accountId) throw unknown();
    return new InsufficientFundsError(accountId, assetId, requested, availableBalance);
  }

  const writer = createHttpLedgerClient({
    ...shared,
    timeoutMs: timeoutMs ?? POST_TIMEOUT_MS,
    retries: 0,
    mapError: async (error, { path, detail, body }) => {
      if (path !== '/trpc/post' || !(error instanceof InsufficientFundsError)) return error;
      try {
        return await definitiveFundsRefusal(detail, body);
      } catch (refusal) {
        return refusal instanceof Error ? refusal : unknown();
      }
    },
  });

  return {
    post: (request) => writer.post(request),
    balance: (ref) => reader.balance(ref),
    balances: (ownerType, ownerId) => reader.balances(ownerType, ownerId),
    getTx: (txId) => reader.getTx(txId),
    getTxByKey: (idempotencyKey) => reader.getTxByKey(idempotencyKey),
  };
}
