import {
  formatAmount,
  parseAmount,
  InsufficientFundsError,
  type AccountRef,
  type Balance,
  type LedgerClient,
  type LedgerTx,
  type PostRequest,
  rehydrateLedgerHttpError,
} from '@intafaced/ledger-client';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';

/**
 * HTTP client for svc-ledger.
 *
 * §2: services never touch another service's tables. Every unit of P2P escrow
 * goes over this client into svc-ledger, which owns the balance graph —
 * svc-p2p holds no balances at all (Doctrine §0.6).
 *
 * It implements the same `LedgerClient` interface as `MemoryLedger`, which the
 * conformance suite proves equivalent to svc-ledger's Postgres engine (§4.4).
 * That equivalence is why the escrow money paths can be tortured in tests
 * without a network and still mean something.
 */
export function createLedgerClient(baseUrl: string, internalSecret: string, options: { timeoutMs?: number } = {}): LedgerClient {
  // Transport budget only: neither an escrow deadline nor a ledger outcome.
  // Node timers overflow above this bound; never silently disable the budget.
  const timeoutMs = options.timeoutMs === undefined ? 15_000 : options.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError('P2P ledger HTTP timeoutMs must be a positive integer at most 2147483647');
  }
  /**
   * Service credentials, per call (§2).
   *
   * svc-ledger's `post` is a `serviceProcedure` now, so this client must prove
   * which service it is. It previously sent `content-type` and nothing else —
   * there was no credential to check even before `post` began checking.
   *
   * Signed per request rather than once at construction, because the signature
   * covers a timestamp: a captured header stops working after the skew window
   * instead of being a permanent bearer token.
   *
   * It also covers the body (L2-6). Identity plus a timestamp left a captured
   * signature replayable against ANY body for 300 seconds — on this path, any
   * escrow lock or release.
   */
  const authHeaders = (payload: string) => serviceAuthHeadersForBody('svc-p2p', internalSecret, payload);

  const url = baseUrl.replace(/\/$/, '');

  async function call<T>(path: string, body: unknown): Promise<T> {
    // Serialised ONCE, and the same string is both signed and sent. Signing
    // `JSON.stringify(body)` and then handing `body` to fetch to re-serialise
    // would digest bytes the server never sees; it presents as a 401 that
    // reproduces only under whatever key order the two calls happened to differ on.
    const payload = JSON.stringify(body);

    const response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(payload) },
      body: payload,
      // The signal remains active while response.text/json reads the body.
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const detail = await response.text();
      // Rehydrate typed funds failure so p2p-service void-on-failed-lock runs
      // in production (MemoryLedger tests already throw InsufficientFundsError).
      throw rehydrateLedgerHttpError(path, response.status, detail);
    }

    return (await response.json()) as T;
  }

  return {
    async post(request: PostRequest): Promise<LedgerTx> {
      // Amounts cross the wire as decimal strings — never as JS numbers, and
      // never as bigint (which JSON cannot represent).
      const wire = {
        idempotencyKey: request.idempotencyKey,
        module: request.module,
        reason: request.reason,
        meta: request.meta ?? {},
        correlationId: request.correlationId,
        entries: request.entries.map((e) => ({
          account: e.account,
          direction: e.direction,
          amount: formatAmount(e.amount),
        })),
      };

      const acknowledgement = await call<unknown>('/trpc/post', wire);
      if (!acknowledgement || typeof acknowledgement !== 'object' || Array.isArray(acknowledgement)) {
        throw new Error('svc-ledger invalid post acknowledgement; outcome unknown');
      }
      const { txId, hash, postedAt } = acknowledgement as Record<string, unknown>;
      if (typeof txId !== 'string' || !txId.trim() || typeof hash !== 'string' || !hash.trim() || typeof postedAt !== 'string') {
        throw new Error('svc-ledger invalid post acknowledgement; outcome unknown');
      }
      // handleS2sPost publishes Date.toISOString(). Reject normalized impossible
      // dates and arbitrary Date.parse strings, without inventing ID/hash formats.
      const serverTimestamp = new Date(postedAt);
      if (!Number.isFinite(serverTimestamp.getTime()) || serverTimestamp.toISOString() !== postedAt) {
        throw new Error('svc-ledger invalid post acknowledgement; outcome unknown');
      }

      return {
        id: txId,
        idempotencyKey: request.idempotencyKey,
        module: request.module,
        reason: request.reason,
        meta: request.meta ?? {},
        postedAt: serverTimestamp,
        hash,
        previousHash: null,
        entries: [],
      };
    },

    async balance(ref: AccountRef): Promise<Balance> {
      const result = await call<{ accountId: string; amount: string }>('/trpc/balance', ref);
      return { account: ref, accountId: result.accountId, amount: parseAmount(result.amount) };
    },

    async balances(ownerType: AccountRef['ownerType'], ownerId: string): Promise<Balance[]> {
      const result = await call<Array<{ accountId: string; assetId: string; kind: string; amount: string }>>('/trpc/balances', {
        ownerType,
        ownerId,
      });

      return result.map((b) => ({
        account: { ownerType, ownerId, assetId: b.assetId, kind: b.kind as AccountRef['kind'] },
        accountId: b.accountId,
        amount: parseAmount(b.amount),
      }));
    },

    /**
     * Not exposed over the internal ledger API.
     *
     * svc-p2p never needs it, and that is a design property rather than a
     * limitation: "did the escrow lock post?" is answered by *calling
     * `escrowLock` again*. The recipe's business key
     * (`p2p.escrow.lock:<tradeId>`) makes the retry return the original
     * transaction if it did, and fail on funds if it did not. Asking the ledger
     * a question is a round trip that can itself fail; re-driving the operation
     * converges either way.
     */
    async getTx(): Promise<LedgerTx | null> {
      throw new Error('getTx is not exposed over the internal ledger API — query svc-ledger directly');
    },

    async getTxByKey(): Promise<LedgerTx | null> {
      throw new Error('getTxByKey is not exposed over the internal ledger API — re-drive the idempotent recipe instead');
    },
  };
}
