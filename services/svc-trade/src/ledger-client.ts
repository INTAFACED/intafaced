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
import { installPreTradeCredit } from './futures/pretrade-credit.js';
import { installPositionMode } from './futures/position-mode.js';
import { installCollateralHaircut } from './futures/collateral-haircut.js';
import { installOverload } from './futures/overload.js';

/** CARD F5 — index.ts loads this client at boot; mill wraps place/open before hold/lock. */
installPreTradeCredit();
/** CARD F6 — explicit one_way / hedge before futuresMarginLock. */
installPositionMode();
/** CARD F8 — owner haircuts; yield/staked refuse; posted margin is not a loan. */
installCollateralHaircut();
/** Overload refuses new risk. Reduce-only and close-position stay. Unset switch is off. */
installOverload();

/**
 * HTTP client for svc-ledger.
 *
 * §2: services never touch another service's tables. Every hold, every fill and
 * every release this service performs goes over this client into svc-ledger,
 * which owns the balance graph — this service owns none of it (Doctrine §0.6).
 *
 * It implements the same `LedgerClient` interface the in-memory reference and
 * the Postgres engine implement, so the money paths in `spot/trade-service.ts`
 * are written once and tested against the reference without a network.
 *
 * Auth is body-bound (L2-6): serialize once, sign those bytes, send the same
 * string. v1 service-only signatures were replayable against any post body.
 */
function isTxByKeyBody(value: unknown): value is {
  found?: unknown;
  txId?: unknown;
  hash?: unknown;
  postedAt?: unknown;
  module?: unknown;
  reason?: unknown;
} {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function createLedgerClient(baseUrl: string, internalSecret: string): LedgerClient {
  const authHeaders = (payload: string) => serviceAuthHeadersForBody('svc-trade', internalSecret, payload);

  const url = baseUrl.replace(/\/$/, '');

  async function call<T>(path: string, body: unknown): Promise<T> {
    const payload = JSON.stringify(body);
    // 25s is the caller deadline inside HOLD_UNKNOWN_IN_FLIGHT_BOUND_SECONDS
    // (hold-outcome.ts). TimeoutError has no cause.code, so classifyHoldPostError
    // returns unknown and the order stays. A timeout is never a refusal.
    const response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(payload) },
      body: payload,
      signal: AbortSignal.timeout(25_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw rehydrateLedgerHttpError(path, response.status, detail);
    }

    return (await response.json()) as T;
  }

  return {
    async post(request: PostRequest): Promise<LedgerTx> {
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

    async getTx(): Promise<LedgerTx | null> {
      throw new Error('getTx is not exposed over the internal ledger API — query svc-ledger directly');
    },

    /**
     * Existence check by idempotency key. Convert settle asks "was this release /
     * hold / fill already booked?" before it posts; this used to throw here, so
     * every Convert accept came back as a 500. The ledger answers with the
     * identifying fields only; entries stay in svc-ledger.
     */
    async getTxByKey(idempotencyKey: string): Promise<LedgerTx | null> {
      const result = await call<unknown>('/trpc/txByKey', { idempotencyKey });
      if (!isTxByKeyBody(result)) throw new Error('ledger txByKey returned an unreadable body');
      if (result.found === false) return null;
      if (result.found !== true) throw new Error('ledger txByKey returned an unreadable body');
      if (typeof result.txId !== 'string' || result.txId.length === 0) {
        throw new Error('ledger txByKey found a transaction without a txId');
      }
      if (
        typeof result.hash !== 'string' ||
        typeof result.postedAt !== 'string' ||
        typeof result.module !== 'string' ||
        typeof result.reason !== 'string'
      ) {
        throw new Error('ledger txByKey found a transaction with an unreadable body');
      }
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
