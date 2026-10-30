import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import type { LifecycleAdmissionProof } from '../lifecycle-proof.js';

/**
 * THE ENGINE, AS SEEN FROM HERE (§5.1 / §5.2).
 *
 * svc-matching is a separate service with its own process, its own journal and
 * its own tests. §15.2 forbids reaching into it: cross-service work goes over
 * an interface, never over an import of the other service's source. So this
 * file declares the narrow port svc-trade needs and an HTTP implementation of
 * it, shaped exactly to the routes svc-matching's README publishes.
 *
 * EVERY AMOUNT HERE IS A DECIMAL STRING. That is the engine's wire format and
 * it is not negotiable — a JSON number would round the 18th decimal place away
 * silently, and the 18th decimal place is where a book stops reconciling. The
 * strings are parsed into `Amount` the moment they cross into `trade-service.ts`
 * and never travel further as strings.
 *
 * What this port exposes for money-safe recovery: submit, cancel, native
 * amend (PATCH), mass-cancel by account owner, depth, the non-destructive
 * live-order list (GET), and scheduled reconcile. It does not import matching
 * source (§15.2). Mass-cancel owner is accountId. Session is not a field —
 * this client never sends one.
 */

export type EngineOrderType = 'market' | 'limit' | 'stop' | 'stop_limit' | 'option';
export type EngineSide = 'buy' | 'sell';
export type EngineTif = 'GTC' | 'IOC' | 'FOK' | 'PO' | 'MOC' | 'GTD' | 'GTT';

export interface EngineSubmitRequest {
  readonly orderId: string;
  /**
   * §5.1: "it speaks in account IDs". This service passes the USER id. On a
   * self-trade the engine expires the account's own resting order and the
   * incoming order continues (svc-matching engine/self-trade.ts); there is no
   * self-fill. Empty accountIds still fill. Sub-accounts are
   * a reporting dimension here, not separate trading identities. Trade does
   * not invent STP modes.
   */
  readonly accountId: string;
  readonly type: EngineOrderType;
  readonly side: EngineSide;
  readonly qty: string;
  readonly price?: string | null;
  readonly stopPrice?: string | null;
  /** Caller stop trigger. Matching refuses missing. Trade does not invent a trigger. */
  readonly stopPx?: string | null;
  readonly tif: EngineTif;
  /** Caller expire instant for GTD/GTT. The engine does not invent one. */
  readonly expireAt?: string;
  /** Caller reduce-only. Matching refuses would_increase_position. Trade does not invent a mark. */
  readonly reduceOnly?: boolean;
  /** Visible peak for an iceberg. Matching refuses missing/not-smaller. Trade does not invent a display. */
  readonly iceberg?: boolean;
  readonly displayQty?: string | null;
  /** Trail distance. Matching refuses missing. Trade does not invent a distance. */
  readonly trail?: string | null;
  /** Injected mark the trail walks with. Matching refuses missing. Trade does not invent a mark. */
  readonly mark?: string | null;
  /** Minimum fill qty. Missing or zero is not set. Trade does not invent a default. */
  readonly minQty?: string | null;
  /** All-or-none. Missing or false is a normal place. Trade does not invent AON. */
  readonly aon?: boolean;
  /** Peg / midpoint / relative. Matching refuses true. Trade does not invent a mid. */
  readonly peg?: boolean;
  readonly midpoint?: boolean;
  readonly relative?: boolean;
  /** Auction / benchmark. Matching refuses true. Trade does not invent an auction price. */
  readonly auction?: boolean;
  readonly benchmark?: boolean;
  /**
   * Price collar. Matching refuses missing min/max (`missing_collar`) and a
   * submit outside the band (`outside_collar`). Trade does not invent last or mid.
   */
  readonly collar?: boolean;
  readonly min?: string | null;
  readonly max?: string | null;
  /** Option strike. Matching refuses missing. Trade does not invent a mark. */
  readonly strike?: string | null;
  /** Option expiry. Matching refuses missing. Trade does not invent an expiry. */
  readonly expiry?: string | null;
  /** Exercise a long option at strike. Matching refuses missing strike/expiry. Trade does not invent a mark. */
  readonly exercise?: boolean;
  /** Assign a short option when a long is exercised. Matching refuses missing strike/expiry. Trade does not invent a mark. */
  readonly assign?: boolean;
  /**
   * Combo / multi-leg. Named legs with ratios required. Matching matches as one
   * instrument. Trade posts one hold/fill — never per-leg invented money.
   * Amounts on the wire are decimal strings.
   */
  readonly combo?: boolean;
  readonly legs?: readonly EngineComboLeg[] | null;
  /** Exact PX-S01 admission evidence used before the hold and this submit. */
  readonly lifecycleProof?: LifecycleAdmissionProof;
}

/** One named combo leg. Ratio/strike/expiry are decimal strings — never JSON numbers. */
export interface EngineComboLeg {
  readonly name: string | null;
  readonly ratio: string | null;
  readonly strike: string | null;
  readonly expiry: string | null;
}

export interface EngineFill {
  readonly sequence: number;
  readonly makerOrderId: string;
  readonly makerAccountId: string;
  readonly takerOrderId: string;
  readonly takerAccountId: string;
  readonly takerSide: EngineSide;
  readonly price: string;
  readonly qty: string;
}

export interface EngineResting {
  readonly kind: 'book' | 'stop';
  readonly orderId: string;
  readonly accountId: string;
  readonly side: EngineSide;
  readonly price: string;
  readonly remaining: string;
  readonly sequence: number;
  /** Instruction version. Absent on pre-amend engine replies; treat as 1. */
  readonly version?: number;
}

/**
 * Quantity that left the engine without filling — an IOC remainder, a market
 * remainder, a self-trade-prevention pull, or an explicit cancel.
 *
 * svc-matching unifies these into one shape because svc-trade does the same
 * thing with all of them: release what is left of the hold.
 */
export interface EngineCancellation {
  readonly orderId: string;
  readonly accountId: string;
  readonly remainingQty: string;
  readonly sequence: number;
  readonly reason: string;
}

export interface EngineRejection {
  readonly code: string;
  readonly message: string;
}

export interface EngineTriggerOutcome {
  readonly orderId: string;
  readonly sequence: number;
  readonly fills: readonly EngineFill[];
  readonly resting: EngineResting | null;
  readonly cancellations: readonly EngineCancellation[];
  readonly rejected: EngineRejection | null;
}

export interface EngineSubmitResult {
  readonly accepted: boolean;
  readonly sequence: number | null;
  readonly fills: readonly EngineFill[];
  readonly resting: EngineResting | null;
  /**
   * Matching operator halt (`market_halted`), venue halt-all (`venue_halted`),
   * reduce-only (`market_reduce_only`), post-only (`market_post_only`),
   * prelaunch (`market_prelaunch`), expire (`market_expired`), delist
   * (`market_delisted`), missing collar band (`missing_collar`), or submit
   * outside the caller collar (`outside_collar`). One-market halt and halt-all
   * refuse every submit; reduce-only refuses opens/increases; post-only refuses
   * non-post-only submits; prelaunch refuses public submits until OPEN; expire
   * and delist refuse new submits (resume/open do not reopen). Collar uses
   * caller min/max — the engine does not invent last or mid. Cancel stays.
   * Trade surfaces the refuse; it does not swallow as a fill.
   */
  readonly rejected: EngineRejection | null;
  readonly cancellations: readonly EngineCancellation[];
  readonly triggered: readonly EngineTriggerOutcome[];
}

export interface EngineCancelResult {
  readonly cancelled: boolean;
  readonly orderId: string;
  readonly sequence: number | null;
  readonly cancellation: EngineCancellation | null;
}

export const SESSION_UNSUPPORTED = 'session_unsupported' as const;

export type EngineMassCancelRefuse = typeof SESSION_UNSUPPORTED | 'missing_account';

/**
 * Matching POST /markets/:marketId/orders/mass-cancel body.
 * Owner is accountId. This client never adds a session.
 */
export interface EngineMassCancelRequest {
  readonly accountId: string;
}

export interface EngineMassCancelResult {
  readonly accepted: boolean;
  readonly accountId: string;
  readonly cancellations: readonly EngineCancellation[];
  readonly rejected: EngineRejection | null;
}

export function readSessionId(cmd: { readonly sessionId?: string | null }): string | null {
  const raw = cmd.sessionId;
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function massCancelSessionRefuse(
  sessionId: string | null,
): { readonly code: EngineMassCancelRefuse; readonly message: string } | null {
  if (sessionId === null) return null;
  return {
    code: SESSION_UNSUPPORTED,
    message: 'session mass-cancel is unsupported; trade does not invent a session',
  };
}

/** Claimed owner must be the authenticated account. Missing claim uses auth. Empty claim cannot apply. */
export function massCancelAccountRefuse(
  authenticatedAccountId: string,
  claimedAccountId: string | null,
): { readonly code: 'missing_account' | 'not_owner'; readonly message: string } | null {
  if (authenticatedAccountId.length === 0) {
    return { code: 'missing_account', message: 'missing account cannot mass-cancel; trade does not invent an owner' };
  }
  if (claimedAccountId === null) return null;
  if (claimedAccountId.length === 0) {
    return { code: 'missing_account', message: 'missing account cannot mass-cancel; trade does not invent an owner' };
  }
  if (claimedAccountId !== authenticatedAccountId) {
    return { code: 'not_owner', message: 'mass-cancel is the authenticated account only' };
  }
  return null;
}

export type EngineAmendPriority = 'retained' | 'lost';

/** PATCH /markets/:id/orders/:id body. Amounts are decimal strings. */
export interface EngineAmendRequest {
  readonly expectedVersion: number;
  readonly qty?: string;
  readonly price?: string;
  readonly stopPrice?: string;
  readonly tif?: EngineTif;
  readonly lifecycleProof: LifecycleAdmissionProof;
}

export interface EngineAmendResult {
  readonly accepted: boolean;
  readonly orderId: string;
  readonly sequence: number | null;
  readonly version: number | null;
  readonly priority: EngineAmendPriority | null;
  readonly fills: readonly EngineFill[];
  readonly resting: EngineResting | null;
  readonly rejected: EngineRejection | null;
  readonly cancellations: readonly EngineCancellation[];
  readonly triggered: readonly EngineTriggerOutcome[];
}

export interface EngineDepth {
  readonly bids: ReadonlyArray<readonly [string, string]>;
  readonly asks: ReadonlyArray<readonly [string, string]>;
  readonly sequence: number;
}

/**
 * One resting / stop order on the engine (GET /markets/:id/orders wire).
 * Amounts are decimal strings — never JSON numbers.
 */
export interface EngineLiveOrder {
  readonly marketId: string;
  readonly orderId: string;
  readonly accountId: string;
  readonly kind: 'book' | 'stop';
  readonly side: EngineSide;
  readonly price: string;
  readonly remaining: string;
  readonly sequence: number;
  readonly version?: number;
}

export interface EngineLiveOrders {
  readonly marketId: string;
  readonly orders: readonly EngineLiveOrder[];
}

/**
 * Caller's view of one order for `POST /reconcile` (svc-matching wire shape).
 * Declared here so trade never imports matching source (§15.2).
 */
export type CounterpartOrderState = 'pending' | 'open' | 'terminal';

export interface CounterpartOrder {
  readonly orderId: string;
  readonly marketId: string;
  readonly state: CounterpartOrderState;
  /** Decimal string. */
  readonly remaining: string;
  /** Live hold > 0 — asserted by trade from ledger, never computed by engine. */
  readonly funded: boolean;
  readonly detail?: string;
}

export type ReconcileVerdict = 'clean' | 'auto' | 'refuse';

export interface ReconcileFinding {
  readonly orderId: string;
  readonly case: string;
  readonly verdict: ReconcileVerdict;
  readonly engine: string;
  readonly counterpart: string;
  readonly reason: string;
}

export interface ReconcileReport {
  readonly checked: number;
  readonly agreed: number;
  readonly findings: readonly ReconcileFinding[];
  readonly refusals: number;
  readonly ok: boolean;
}

/**
 * Engine market-id set (GET /markets wire). Ids only — never invent listings.
 * Empty array = engine has no books yet (honest empty, not an outage).
 */
export interface EngineMarketList {
  readonly markets: readonly string[];
  /** Operator halts on matching's board: the whole venue, and the halted market ids. Older engines omit them. */
  readonly venueHalted?: boolean;
  readonly halted?: readonly string[];
  /** When each halted market's halt began (ISO), and the venue halt's start (null when open). Older engines omit them. */
  readonly haltedSince?: Readonly<Record<string, string>>;
  readonly venueHaltedSince?: string | null;
}

export interface EngineMarkResult {
  readonly accepted: boolean;
  readonly applied: boolean;
  readonly rejected: { readonly code: string; readonly message: string } | null;
}

export interface MatchingClient {
  submit(marketId: string, request: EngineSubmitRequest): Promise<EngineSubmitResult>;
  cancel(marketId: string, orderId: string): Promise<EngineCancelResult>;
  /**
   * Mass-cancel by owner — POST /markets/:marketId/orders/mass-cancel.
   * Body is `{ accountId }` only. Trade never invents a session.
   * 200 + accepted:false is a refused mass-cancel (book unchanged).
   */
  massCancel(marketId: string, request: EngineMassCancelRequest): Promise<EngineMassCancelResult>;
  /**
   * Native amend — PATCH /markets/:marketId/orders/:orderId.
   * Writer is svc-trade. PX-S01 action must be AMEND. 200 + accepted:false
   * is a refused amend (order unchanged); transport failure is indeterminate.
   */
  amend(marketId: string, orderId: string, request: EngineAmendRequest): Promise<EngineAmendResult>;
  /**
   * `limit` is required. Unset refuses (never invent 1). Owner-explicit 1 is BBO.
   * Matching 200 empty is a live empty ladder. Matching 404 MarketNotFound throws
   * MatchingNoBookError — never `{ bids:[], asks:[], sequence:0 }`.
   */
  depth(marketId: string, limit: number): Promise<EngineDepth>;
  /**
   * Non-destructive liveness read — GET /markets/:marketId/orders.
   * Prefer this over cancel when only asking "is order X live?".
   * Matching 200 `{ orders: [] }` is a live empty list. Matching 404 throws
   * MatchingNoBookError — never a fabricated empty list.
   */
  /**
   * Resting orders of one market, read at the engine's page size. When the page is full the list
   * may be cut, so a full page that does not hold `orderId` throws instead of claiming absence.
   */
  listOrders(marketId: string, orderId?: string): Promise<EngineLiveOrders>;
  /**
   * Whole-engine market id set — GET /markets.
   * Used for market-id drift alarm vs trade.markets (handoff §4.5).
   * Never mutates books; empty list is honest.
   */
  listMarkets(): Promise<EngineMarketList>;
  /**
   * Non-destructive engine↔counterpart compare. Service-auth only.
   * Returns 200 with `ok: false` on refusals — that is a report, not an outage.
   */
  reconcile(orders: readonly CounterpartOrder[]): Promise<ReconcileReport>;
  /**
   * Walk this market's trailing stops with a server-side mark — POST /markets/:marketId/mark.
   * `applied` is true only when a peak or a trigger moved. A refused mark (blank, halted market) is accepted:false.
   */
  markTrailingStops(marketId: string, mark: string): Promise<EngineMarkResult>;
}

/** Engine hop: unset/null throws. Owner-explicit 1 is a published BBO window. */
export function publishedMatchingDepthLimit(value: number | undefined | null): number {
  if (value === undefined || value === null) {
    throw new Error('MatchingClient depth limit is unset — refuse to invent 1');
  }
  return value;
}

export class MatchingUnavailableError extends Error {
  constructor(
    message: string,
    readonly code = 'trade.matching_unavailable',
  ) {
    super(message);
    this.name = 'MatchingUnavailableError';
  }
}

/**
 * Matching GET /depth or GET /orders answered 404 MarketNotFound —
 * `engine.depth === null` / `!engine.hasMarket`. That is not a live empty
 * ladder and not an outage. WS already surfaces this as 404 NoBook.
 */
export class MatchingNoBookError extends Error {
  constructor(
    readonly marketId: string,
    message = `matching holds no book for ${marketId}`,
    readonly code = 'trade.no_book',
  ) {
    super(message);
    this.name = 'MatchingNoBookError';
  }
}

/**
 * HTTP implementation.
 *
 * A rejection is a 200 with `accepted: false` — post-only refusing to cross is
 * the feature working, not an outage. Only transport failures and malformed
 * bodies throw, and when one does the caller must treat the submission as
 * INDETERMINATE: the engine may have accepted it. `trade-service.ts` handles
 * that case explicitly rather than assuming a failed request means a failed
 * order.
 */
/**
 * Page size for `GET /markets/:id/orders`. Matching refuses a request with no limit
 * (`matching.resting_orders_limit_unset`) and accepts 1..500, so 500 is the widest read it
 * allows: the smallest chance that a live order sits past the page. Evidence: matching
 * `l2-limit.ts` (cap 500). A full page cannot prove an order is absent, see `listOrders`.
 */
export const MATCHING_RESTING_ORDERS_PAGE = 500;

/** How long one call to the engine may take before it counts as unreachable. Not a market or money limit. */
export const MATCHING_FETCH_MS = 5_000;

export function createMatchingClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
  options: { timeoutMs?: number } = {},
): MatchingClient {
  const url = baseUrl.replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? MATCHING_FETCH_MS;
  // Every engine call is bounded. A hung engine must end as the same MatchingUnavailableError a refused connection does,
  // so the caller's hold recovery runs instead of a request waiting forever with funds held.
  const send = (target: string, init: RequestInit) => fetch(target, { ...init, signal: AbortSignal.timeout(timeoutMs) });

  /**
   * Order WRITES to the engine are service-only (§2, §5.1).
   *
   * The engine is allowed to be pure precisely because it never sees an
   * unfunded order — and that holds only while svc-trade is the only thing able
   * to submit one. Those routes accepted anyone at all until this change.
   */
  // Body-bound S2S (L2-6). Empty body for GET/DELETE; serialize once on POST.
  const sign = serviceCallSigner({ service: 'svc-trade', audience: 'svc-matching', legacySecret: internalSecret, s2s });
  // The request is what a key signature binds: method, full URL, body and content type.
  // GET and DELETE send no content-type, so the signed content type is empty; calls with a body send JSON.
  const authHeaders = (method: string, path: string, payload?: string) =>
    sign(payload ?? '', {
      method,
      url: new URL(`${url}${path}`),
      contentType: payload === undefined ? '' : 'application/json',
    });

  async function call<T>(path: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await send(`${url}${path}`, init);
    } catch (err) {
      throw new MatchingUnavailableError(`svc-matching ${path} is unreachable: ${(err as Error).message}`);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new MatchingUnavailableError(`svc-matching ${path} failed (${response.status}): ${detail}`);
    }

    return (await response.json()) as T;
  }

  return {
    async submit(marketId, request) {
      const payload = JSON.stringify(request);
      const path = `/markets/${encodeURIComponent(marketId)}/orders`;
      return call<EngineSubmitResult>(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders('POST', path, payload) },
        body: payload,
      });
    },

    async cancel(marketId, orderId) {
      const path = `/markets/${encodeURIComponent(marketId)}/orders/${encodeURIComponent(orderId)}`;
      let response: Response;
      try {
        response = await send(`${url}${path}`, { method: 'DELETE', headers: authHeaders('DELETE', path) });
      } catch (err) {
        throw new MatchingUnavailableError(`svc-matching ${path} is unreachable: ${(err as Error).message}`);
      }

      // 404 means the order is not live in the book — it already filled, or it
      // was already cancelled. That is an answer, not a failure: the caller
      // still has to reconcile the hold, and throwing here would leave it held.
      if (response.status === 404) {
        return { cancelled: false, orderId, sequence: null, cancellation: null };
      }
      if (!response.ok) {
        throw new MatchingUnavailableError(`svc-matching ${path} failed (${response.status})`);
      }

      return (await response.json()) as EngineCancelResult;
    },

    async massCancel(marketId, request) {
      const path = `/markets/${encodeURIComponent(marketId)}/orders/mass-cancel`;
      // Owner is accountId. Never add sessionId — matching refuses it, and
      // this client does not invent a session.
      const payload = JSON.stringify({ accountId: request.accountId });
      let response: Response;
      try {
        response = await send(`${url}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders('POST', path, payload) },
          body: payload,
        });
      } catch (err) {
        throw new MatchingUnavailableError(`svc-matching ${path} is unreachable: ${(err as Error).message}`);
      }

      if (response.status === 400) {
        return {
          accepted: false,
          accountId: request.accountId,
          cancellations: [],
          rejected: { code: 'missing_account', message: 'missing account cannot mass-cancel; the engine does not invent an owner' },
        };
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new MatchingUnavailableError(`svc-matching ${path} failed (${response.status}): ${detail}`);
      }

      const body = (await response.json()) as EngineMassCancelResult;
      return {
        accepted: body.accepted,
        accountId: body.accountId,
        cancellations: body.cancellations ?? [],
        rejected: body.rejected ?? null,
      };
    },

    async amend(marketId, orderId, request) {
      const path = `/markets/${encodeURIComponent(marketId)}/orders/${encodeURIComponent(orderId)}`;
      const payload = JSON.stringify(request);
      let response: Response;
      try {
        response = await send(`${url}${path}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...authHeaders('PATCH', path, payload) },
          body: payload,
        });
      } catch (err) {
        throw new MatchingUnavailableError(`svc-matching ${path} is unreachable: ${(err as Error).message}`);
      }

      // 404 = not live. That is an answer, not an outage. The caller must NOT
      // treat it as a cancel: the order may have filled while the PATCH was in flight.
      if (response.status === 404) {
        return {
          accepted: false,
          orderId,
          sequence: null,
          version: null,
          priority: null,
          fills: [],
          resting: null,
          rejected: { code: 'order_not_found', message: `order ${orderId} is not live` },
          cancellations: [],
          triggered: [],
        };
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new MatchingUnavailableError(`svc-matching ${path} failed (${response.status}): ${detail}`);
      }

      return (await response.json()) as EngineAmendResult;
    },

    /**
     * Empty ≠ failed ≠ zero.
     *
     * Matching GET /depth 404 is MarketNotFound (`engine.depth === null`) — the
     * engine does not hold that market. That is not a live empty ladder.
     * Matching 200 `{ bids:[], asks:[] }` is a real empty book and stays 200.
     * Transport / 5xx stays MatchingUnavailableError (public 502).
     */
    async depth(marketId, limit) {
      const published = publishedMatchingDepthLimit(limit);
      const path = `/markets/${encodeURIComponent(marketId)}/depth?limit=${published}`;
      let response: Response;
      try {
        response = await send(`${url}${path}`, { method: 'GET', headers: authHeaders('GET', path) });
      } catch (err) {
        throw new MatchingUnavailableError(`svc-matching ${path} is unreachable: ${(err as Error).message}`);
      }

      if (response.status === 404) throw new MatchingNoBookError(marketId);

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new MatchingUnavailableError(`svc-matching ${path} failed (${response.status}): ${detail}`);
      }

      try {
        return (await response.json()) as EngineDepth;
      } catch (err) {
        throw new MatchingUnavailableError(`svc-matching ${path} returned a body that is not JSON: ${(err as Error).message}`);
      }
    },

    /**
     * Non-destructive live book read. Same 404-vs-empty discipline as depth:
     * matching 200 `{ orders: [] }` is a live empty list; matching 404 is
     * MarketNotFound, not a fabricated empty list.
     */
    async listOrders(marketId, orderId) {
      const path = `/markets/${encodeURIComponent(marketId)}/orders?limit=${MATCHING_RESTING_ORDERS_PAGE}`;
      let response: Response;
      try {
        response = await send(`${url}${path}`, { method: 'GET', headers: authHeaders('GET', path) });
      } catch (err) {
        throw new MatchingUnavailableError(`svc-matching ${path} is unreachable: ${(err as Error).message}`);
      }

      if (response.status === 404) throw new MatchingNoBookError(marketId);
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new MatchingUnavailableError(`svc-matching ${path} failed (${response.status}): ${detail}`);
      }

      const listed = (await response.json()) as EngineLiveOrders;
      if (listed.orders.length >= MATCHING_RESTING_ORDERS_PAGE && !(orderId && listed.orders.some((o) => o.orderId === orderId))) {
        throw new MatchingUnavailableError(`svc-matching ${path} returned a full page; absence cannot be proven`);
      }
      return listed;
    },

    /**
     * Market-id set for drift alarm. Always a list of ids — never invents a
     * market row on either side. Transport failure throws MatchingUnavailable;
     * empty markets is a valid 200.
     */
    async listMarkets() {
      return call<EngineMarketList>('/markets', {
        method: 'GET',
        headers: authHeaders('GET', '/markets'),
      });
    },

    /**
     * Scheduled / operator sweep. Body is the trade-side counterpart view;
     * engine compares against resting books and writes nothing.
     */
    async reconcile(orders) {
      const payload = JSON.stringify({ orders });
      return call<ReconcileReport>('/reconcile', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders('POST', '/reconcile', payload) },
        body: payload,
      });
    },

    async markTrailingStops(marketId, mark) {
      const path = `/markets/${encodeURIComponent(marketId)}/mark`;
      const payload = JSON.stringify({ mark });
      return call<EngineMarkResult>(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders('POST', path, payload) },
        body: payload,
      });
    },
  };
}
