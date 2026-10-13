import {
  formatAmount,
  parseAmount,
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
 * §2: services never touch another service's tables. Every value movement in
 * svc-pay — capture, refund, settlement, payout — goes over this client into
 * svc-ledger, which owns the balance graph.
 *
 * It implements the same `LedgerClient` interface the in-memory reference and
 * the Postgres engine implement, so the money paths in `payment-service.ts` are
 * written once and tested against the reference without a network.
 */
export function createLedgerClient(baseUrl: string, internalSecret: string): LedgerClient {
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
   * capture, refund, settlement or payout.
   */
  const authHeaders = (payload: string) => serviceAuthHeadersForBody('svc-pay', internalSecret, payload);

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
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // Preserve the ledger's own error text: on a refund,
      // 'ledger.insufficient_funds' means the merchant cannot cover it and
      // 'ledger.frozen' means an operator has stopped the module. Collapsing
      // them into "request failed" would make both unactionable.
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

      const result = await call<{ txId: string; hash: string; postedAt: string }>('/trpc/post', wire);

      return {
        id: result.txId,
        idempotencyKey: request.idempotencyKey,
        module: request.module,
        reason: request.reason,
        meta: request.meta ?? {},
        postedAt: new Date(result.postedAt),
        hash: result.hash,
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
     * One booked transaction by its id, through svc-ledger's read-only
     * `/trpc/txById` door. This used to throw, so any caller holding a ledger tx
     * id (a business transfer receipt) failed on a real deployment while the
     * in-memory ledger in the tests answered it. Same signing and transport as
     * every other call; "not booked" is `null`, as in-process.
     *
     * The door carries each entry's account, asset, direction and amount, which
     * is what a caller verifying a receipt reads. `meta`, the hash chain links
     * and each entry's own id and running balance stay in the ledger.
     */
    async getTx(txId: string): Promise<LedgerTx | null> {
      const result = await call<
        | { found: false }
        | {
            found: true;
            txId: string;
            idempotencyKey: string;
            hash: string;
            postedAt: string;
            module: string;
            reason: string;
            entries: Array<{ accountId: string; assetId: string; direction: 'debit' | 'credit'; amount: string }>;
          }
      >('/trpc/txById', { txId });
      if (result.found === false) return null;
      // Anything but an explicit `found` is not an answer: null would read as "never booked".
      if (result.found !== true) throw new Error('svc-ledger answered a transaction lookup without a `found` verdict');
      return {
        id: result.txId,
        idempotencyKey: result.idempotencyKey,
        module: result.module,
        reason: result.reason,
        meta: {},
        postedAt: new Date(result.postedAt),
        hash: result.hash,
        previousHash: null,
        entries: result.entries.map((e) => ({
          // Not carried by the door; no caller reads them.
          id: '',
          txId: result.txId,
          accountId: e.accountId,
          assetId: e.assetId,
          direction: e.direction,
          amount: parseAmount(e.amount),
          balanceAfter: 0n,
        })),
      };
    },

    /**
     * Existence check by idempotency key, through `/trpc/txByKey`. Money paths
     * ask "was this already booked?" before they post; this used to throw, so a
     * first payout, a card cashback settle and a business transfer proposal all
     * failed on a real deployment. The door answers the identifying fields only;
     * entries stay in svc-ledger. Not booked is `null`, as in-process.
     */
    async getTxByKey(idempotencyKey: string): Promise<LedgerTx | null> {
      const result = await call<
        { found: false } | { found: true; txId: string; hash: string; postedAt: string; module: string; reason: string }
      >('/trpc/txByKey', { idempotencyKey });
      if (result.found === false) return null;
      // Anything but an explicit `found` is not an answer: null would read as "never booked".
      if (result.found !== true) throw new Error('svc-ledger answered a transaction lookup without a `found` verdict');
      return {
        id: result.txId,
        idempotencyKey,
        module: result.module,
        reason: result.reason,
        meta: {},
        postedAt: new Date(result.postedAt),
        hash: result.hash,
        previousHash: null,
        entries: [],
      };
    },
  };
}
