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
import type { HistoryRange, LedgerEntryRecord, LedgerHistory } from './analytics/ledger-history.js';
import type { LedgerHistoryPages, LedgerPageRequest } from './activity/activity-service.js';

/**
 * HTTP client for svc-ledger.
 *
 * §2: services never touch another service's tables. Every movement svc-bank
 * makes — a transfer between spaces, an earn deposit, a day's interest — goes
 * over this client into svc-ledger, which owns the balance graph.
 *
 * It implements the same `LedgerClient` interface the in-memory reference and
 * the Postgres engine implement, so the money paths in this service are written
 * once and tested against the reference without a network.
 */
export function createLedgerClient(baseUrl: string, internalSecret: string): LedgerClient {
  /**
   * Service credentials, per call (§2) — body-bound (T-04 / L2-6).
   *
   * svc-ledger's `post` is a `serviceProcedure`. Signing identity + timestamp
   * alone left a captured signature replayable against ANY body for ~300s.
   * Body bind matches svc-token and closes that hole on earn/loan money posts.
   */
  const authHeaders = (payload: string) => serviceAuthHeadersForBody('svc-bank', internalSecret, payload);

  const url = baseUrl.replace(/\/$/, '');

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

      const result = await call<{ txId: string; hash: string; postedAt: string }>(url, '/trpc/post', wire, authHeaders);

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
      const result = await call<{ accountId: string; amount: string }>(url, '/trpc/balance', ref, authHeaders);
      return { account: ref, accountId: result.accountId, amount: parseAmount(result.amount) };
    },

    async balances(ownerType: AccountRef['ownerType'], ownerId: string): Promise<Balance[]> {
      const result = await call<Array<{ accountId: string; assetId: string; kind: string; amount: string }>>(
        url,
        '/trpc/balances',
        { ownerType, ownerId },
        authHeaders,
      );

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
      >(url, '/trpc/txById', { txId }, authHeaders);
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
      >(url, '/trpc/txByKey', { idempotencyKey }, authHeaders);
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

/**
 * History adapter for spend analytics.
 *
 * SOCKET (§13): depends on a `ledger.history` procedure that svc-ledger does not
 * expose yet. Declaring it is a `packages/contracts` + svc-ledger PR, which
 * AGENT_PROTOCOL §1 requires to land BEFORE the caller — so this adapter is
 * written against the shape and fails loudly if the endpoint is absent.
 *
 * It deliberately does not fall back to an empty result: a spend view that
 * silently reports zero is worse than one that is unavailable, because the user
 * cannot tell the difference between "you spent nothing" and "we could not ask".
 */
export function createLedgerHistory(baseUrl: string, internalSecret: string): LedgerHistory {
  const url = baseUrl.replace(/\/$/, '');
  // Reads are service-to-service too. `/trpc/history` is not a `serviceProcedure`
  // yet — it does not exist yet — but a read client that cannot identify itself
  // would need changing again the moment it becomes one.
  const authHeaders = (payload: string) => serviceAuthHeadersForBody('svc-bank', internalSecret, payload);

  return {
    async entriesFor(account: AccountRef, range: HistoryRange): Promise<LedgerEntryRecord[]> {
      const result = await call<
        Array<{ txId: string; module: string; reason: string; direction: 'debit' | 'credit'; amount: string; postedAt: string }>
      >(url, '/trpc/history', { account, from: range.from.toISOString(), to: range.to.toISOString() }, authHeaders);

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
 * Same service credential and body-bound signing as every other call here. The
 * ledger's schema is strict: this sends exactly `{ownerType, ownerId, kind,
 * assetId?, limit, cursor?}` and never `purpose`, `before` or anything else. A
 * failure is thrown, never turned into an empty page: "no activity" and "we
 * could not ask" must not look alike.
 */
export function createLedgerHistoryPages(baseUrl: string, internalSecret: string): LedgerHistoryPages {
  const url = baseUrl.replace(/\/$/, '');
  const authHeaders = (payload: string) => serviceAuthHeadersForBody('svc-bank', internalSecret, payload);

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
      }>(url, '/trpc/historyPage', body, authHeaders);

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

async function call<T>(base: string, path: string, body: unknown, auth: (payload: string) => Record<string, string>): Promise<T> {
  // Serialise once so the signature covers the exact bytes on the wire.
  const payload = JSON.stringify(body);
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth(payload) },
    body: payload,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    // Preserve the ledger's own error text: 'ledger.insufficient_funds' and
    // 'ledger.frozen' mean very different things to a caller, and collapsing
    // them into "request failed" would make both unactionable.
    throw rehydrateLedgerHttpError(path, response.status, detail);
  }

  return (await response.json()) as T;
}
