/**
 * trade.ccxt-api — bot-ready capability matrix + refuse surface.
 *
 * Promise (D26-P1-T5 / paste-w10 L02 A1 / TRACKER `trade.ccxt-api`):
 * a bot (or integrator) can read, in one module, which CCXT REST surfaces
 * this venue serves, which are mounted only to refuse, and the exact
 * HTTP status + codes of every refuse arm — without treating a Fastify 404
 * as "wrong URL" or a silent 200 as "leverage set".
 *
 * Contract routes live in `@intafaced/exchange-contract` `REST_ROUTES`.
 * This matrix is the **implementation inventory** in svc-trade: claim ≡ wire.
 * Tests fail when a matrix row drifts from the mounted route or refuse arm.
 *
 * Extensions beyond REST_ROUTES (capabilities, position open/close, margin-call,
 * ADL disclosure doors) are inventoried here so post-MVP futures doors stay
 * discoverable — not "route exists only in private-rest comments".
 *
 * Never invents mids/rates. Live margin-mode stays refuse; isolated re-leverage
 * is supported within the sealed 10× cap.
 */

import { REST_ROUTES, type RestRouteName } from '@intafaced/exchange-contract';

/** How the route behaves for a correct, authorized call. */
export type CcxtCapabilityKind =
  /** Happy path can return 200 when deps/data allow. */
  | 'supported'
  /** Always answers with an explicit refuse (never silent success / bare 404). */
  | 'refuse'
  /**
   * Happy path when data exists; otherwise an explicit refuse arm
   * (e.g. funding rate only when published — never invent "0").
   */
  | 'conditional';

/**
 * Wire shape of the refuse body.
 * - `ccxt` → `{ code, message, intafacedCode }` (CCXT error taxonomy)
 * - `domain` → `{ error, message }` (trade domain refuse; used on price fields)
 */
export type CcxtRefuseWireShape = 'ccxt' | 'domain';

/**
 * One named refuse arm a bot must branch on.
 * ids are stable — do not rename without a product note.
 */
export type CcxtRefuseArm = {
  readonly id: string;
  /** REST_ROUTES name, or extension name (openPosition / closePosition). */
  readonly routeName: string;
  readonly method: string;
  readonly path: string;
  readonly httpStatus: 400 | 403 | 501 | 503;
  /**
   * CCXT `code` when wireShape is `ccxt`; for domain refuses, the stable
   * vocabulary class bots should treat as client error (not retried as venue).
   */
  readonly ccxtCode: string;
  /** Intafaced / domain code on the wire. */
  readonly intafacedCode: string;
  readonly wireShape: CcxtRefuseWireShape;
  /** When this arm fires — plain language for bots and humans. */
  readonly when: string;
};

export type CcxtCapabilityRow = {
  /** REST_ROUTES key, or extension (`openPosition` / `closePosition`). */
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly auth: 'public' | 'private';
  readonly scope: string | null;
  readonly kind: CcxtCapabilityKind;
  /** Refuse-arm ids that can fire on this path (may be empty for pure supported). */
  readonly refuseArmIds: readonly string[];
  readonly notes: string;
};

/**
 * Price fields a caller may not send on position open/close.
 * Must match `PRICE_FIELDS` in private-rest.ts — pin test enforces.
 */
export const CALLER_REFUSED_PRICE_FIELDS = ['entryPrice', 'exitPrice', 'price', 'markPrice'] as const;

/**
 * Explicit refuse arms (done bar: setMarginMode, funding-rate when unsupported,
 * caller price on close). setLeverage is supported; 400 arms below are the
 * live-path refuses, not a blanket 501.
 */
export const CCXT_REFUSE_ARMS: readonly CcxtRefuseArm[] = [
  {
    id: 'setLeverageTooHigh',
    routeName: 'setLeverage',
    method: 'POST',
    path: '/api/v1/positions/leverage',
    httpStatus: 400,
    ccxtCode: 'BadRequest',
    intafacedCode: 'trade.leverage_too_high',
    wireShape: 'domain',
    when: 'requested leverage is above the sealed 10× cap — refused, never clamped',
  },
  {
    id: 'setLeverageWouldLiquidate',
    routeName: 'setLeverage',
    method: 'POST',
    path: '/api/v1/positions/leverage',
    httpStatus: 400,
    ccxtCode: 'BadRequest',
    intafacedCode: 'trade.leverage_would_liquidate',
    wireShape: 'domain',
    when: 'new isolated IM would leave equity ≤ 0 at the current mark — no ledger write',
  },
  {
    id: 'setLeverageInsufficientMargin',
    routeName: 'setLeverage',
    method: 'POST',
    path: '/api/v1/positions/leverage',
    httpStatus: 400,
    ccxtCode: 'InsufficientFunds',
    intafacedCode: 'trade.insufficient_margin',
    wireShape: 'domain',
    when: 'decreasing leverage needs extra futuresMarginAdd the available balance cannot fund — no write',
  },
  {
    id: 'addIsolatedMarginInsufficient',
    routeName: 'addIsolatedMargin',
    method: 'POST',
    path: '/api/v1/positions/margin',
    httpStatus: 400,
    ccxtCode: 'InsufficientFunds',
    intafacedCode: 'trade.insufficient_margin',
    wireShape: 'domain',
    when: 'isolated extra futuresMarginAdd the available balance cannot fund — no write',
  },
  {
    id: 'reduceIsolatedMarginBelowInitial',
    routeName: 'reduceIsolatedMargin',
    method: 'POST',
    path: '/api/v1/positions/margin/reduce',
    httpStatus: 400,
    ccxtCode: 'BadRequest',
    intafacedCode: 'trade.margin_below_initial',
    wireShape: 'domain',
    when: 'reduce would pull isolated collateral below initial margin — no write',
  },
  {
    id: 'reduceIsolatedMarginWouldLiquidate',
    routeName: 'reduceIsolatedMargin',
    method: 'POST',
    path: '/api/v1/positions/margin/reduce',
    httpStatus: 400,
    ccxtCode: 'BadRequest',
    intafacedCode: 'trade.margin_would_liquidate',
    wireShape: 'domain',
    when: 'remaining isolated margin would already be in liquidation at the current mark — no write',
  },
  {
    id: 'setMarginMode',
    routeName: 'setMarginMode',
    method: 'POST',
    path: '/api/v1/positions/margin-mode',
    httpStatus: 501,
    ccxtCode: 'NotSupported',
    intafacedCode: 'trade.margin_mode_unsupported',
    wireShape: 'ccxt',
    when: 'always — live margin-mode change is not built; set at open only',
  },
  {
    id: 'fundingRateSpot',
    routeName: 'fetchFundingRate',
    method: 'GET',
    path: '/api/v1/funding-rate/:symbol',
    httpStatus: 501,
    ccxtCode: 'NotSupported',
    intafacedCode: 'trade.funding_rate_spot_market',
    wireShape: 'ccxt',
    when: 'market.kind is spot — never invent fundingRate "0"',
  },
  {
    id: 'fundingRateUnavailable',
    routeName: 'fetchFundingRate',
    method: 'GET',
    path: '/api/v1/funding-rate/:symbol',
    httpStatus: 501,
    ccxtCode: 'NotSupported',
    intafacedCode: 'trade.funding_rate_unavailable',
    wireShape: 'ccxt',
    when: 'non-spot market with no published funding rate (dep missing or null quote)',
  },
  {
    id: 'callerPriceOnClose',
    routeName: 'closePosition',
    method: 'DELETE',
    path: '/api/v1/positions/:id',
    httpStatus: 400,
    ccxtCode: 'BadRequest',
    intafacedCode: 'trade.price_not_accepted',
    wireShape: 'domain',
    when: `query carries any of ${CALLER_REFUSED_PRICE_FIELDS.join('|')} — mark path only`,
  },
  {
    id: 'callerPriceOnOpen',
    routeName: 'openPosition',
    method: 'POST',
    path: '/api/v1/positions',
    httpStatus: 400,
    ccxtCode: 'BadRequest',
    intafacedCode: 'trade.price_not_accepted',
    wireShape: 'domain',
    when: `body carries any of ${CALLER_REFUSED_PRICE_FIELDS.join('|')} — mark path only`,
  },
  {
    id: 'crossMarginOnOpen',
    routeName: 'openPosition',
    method: 'POST',
    path: '/api/v1/positions',
    httpStatus: 400,
    ccxtCode: 'BadRequest',
    intafacedCode: 'trade.cross_margin_unsupported',
    wireShape: 'domain',
    when: 'body.marginMode is "cross" — isolated only; never coerce to isolated',
  },
  {
    id: 'leverageRequiredOnOpen',
    routeName: 'openPosition',
    method: 'POST',
    path: '/api/v1/positions',
    httpStatus: 400,
    ccxtCode: 'BadRequest',
    intafacedCode: 'trade.leverage_required',
    wireShape: 'domain',
    when: 'body.leverage omitted, blank, or not a decimal string — never default 1x',
  },
  {
    id: 'identityLevelInsufficientOnOpen',
    routeName: 'openPosition',
    method: 'POST',
    path: '/api/v1/positions',
    httpStatus: 403,
    ccxtCode: 'PermissionDenied',
    intafacedCode: 'trade.identity_level_insufficient',
    wireShape: 'domain',
    when: 'verification tier is below the tier the eligibility rules name',
  },
  {
    id: 'identityLevelUnavailableOnOpen',
    routeName: 'openPosition',
    method: 'POST',
    path: '/api/v1/positions',
    httpStatus: 403,
    ccxtCode: 'PermissionDenied',
    intafacedCode: 'trade.identity_level_unavailable',
    wireShape: 'domain',
    when: 'the rules need a verification tier and the tier on the request was not readable',
  },
  {
    id: 'futuresUnconfiguredOnOpen',
    routeName: 'openPosition',
    method: 'POST',
    path: '/api/v1/positions',
    httpStatus: 403,
    ccxtCode: 'NotSupported',
    intafacedCode: 'trade.futures_unconfigured',
    wireShape: 'domain',
    when: 'profitSource unset — 403 NotSupported (same as futures_disabled); CCXT must not retry 5xx for operator config',
  },
  {
    id: 'profitSourceUnconfiguredOnClose',
    routeName: 'closePositionQuantity',
    method: 'POST',
    path: '/api/v1/positions/:id/close',
    httpStatus: 403,
    ccxtCode: 'NotSupported',
    intafacedCode: 'trade.profit_source_unconfigured',
    wireShape: 'domain',
    when: 'winning close with profitSource unset — 403 NotSupported; losing/flat close still settles; not a 5xx retry',
  },
  {
    id: 'cancelNotClose',
    routeName: 'closePosition',
    method: 'DELETE',
    path: '/api/v1/positions/:id',
    httpStatus: 400,
    ccxtCode: 'BadRequest',
    intafacedCode: 'trade.cancel_not_close',
    wireShape: 'domain',
    when: 'DELETE is cancel-shaped — it does not close the position or release margin',
  },
] as const;

const refuseIds = (...ids: string[]): readonly string[] => ids;

function route(name: RestRouteName, kind: CcxtCapabilityKind, refuseArmIds: readonly string[], notes: string): CcxtCapabilityRow {
  const r = REST_ROUTES[name];
  return {
    name,
    method: r.method,
    path: r.path,
    auth: r.scope === null ? 'public' : 'private',
    scope: r.scope,
    kind,
    refuseArmIds,
    notes,
  };
}

/**
 * Full capability matrix: every REST_ROUTES entry + position/preview
 * extensions that own refuse arms or private discovery on the private surface.
 */
export const CCXT_CAPABILITY_MATRIX: readonly CcxtCapabilityRow[] = [
  // ── Public meta (beyond REST_ROUTES — bots discover without probing) ──────
  {
    name: 'fetchCapabilities',
    method: 'GET',
    path: '/api/v1/capabilities',
    auth: 'public',
    scope: null,
    kind: 'supported',
    refuseArmIds: [],
    notes: 'Serves this matrix + refuseArms JSON — claim ≡ wire for integrators',
  },

  {
    name: 'fetchFuturesOrderTypes',
    method: 'GET',
    path: '/api/v1/futures/order-types',
    auth: 'public',
    scope: null,
    kind: 'supported',
    refuseArmIds: [],
    notes: 'Per listed futures market: order types, time in force and flags with available or refused plus the typed code (D-orders-01)',
  },

  // ── Public (REST_ROUTES) ──────────────────────────────────────────────────
  route('fetchMarkets', 'supported', [], 'List listings; paper + schedule flags on wire'),
  route('fetchTicker', 'supported', [], 'BBO + last from book/tape; matching 404 is trade.no_book; never invents 24h stats'),
  route('fetchTickers', 'supported', [], 'All-market ticker map; no-book and hop-down omitted, not empty BBO; 200 empty ladder stays'),
  route('fetchOrderBook', 'supported', [], 'Depth from matching; 200 empty is live empty ladder; matching 404 is trade.no_book'),
  route('fetchOHLCV', 'supported', [], 'Candles from real fill tape only; gap ≠ zero candle'),
  route('fetchTrades', 'supported', [], 'Public tape; optional since= ms'),
  route(
    'fetchFundingRate',
    'conditional',
    refuseIds('fundingRateSpot', 'fundingRateUnavailable'),
    'Spot always refuse; futures only when a rate is published — never invent 0',
  ),

  // ── Private (REST_ROUTES) ─────────────────────────────────────────────────
  route('fetchTradingFees', 'supported', [], 'Per-market maker/taker fee rates'),
  route('fetchBalance', 'supported', [], 'Ledger balances for principal'),
  route(
    'createOrder',
    'supported',
    [],
    'Place spot (and gated) order — money path; market, limit, stop_limit (trigger kept in order_stop_trigger)',
  ),
  route('cancelOrder', 'supported', [], 'Cancel one open order by id'),
  route('cancelAllOrders', 'supported', [], 'Cancel open orders; optional symbol filter'),
  route('fetchOrder', 'supported', [], 'One order by id'),
  route('fetchOpenOrders', 'supported', [], 'Open orders; optional symbol'),
  route('fetchClosedOrders', 'supported', [], 'Closed orders; optional symbol/since/limit'),
  route('fetchMyTrades', 'supported', [], 'Account fills; optional symbol/since/limit'),
  route('fetchPositions', 'supported', [], 'Open/closing futures rows; [] when none; null markSource proves no list-time valuation'),
  route(
    'setLeverage',
    'supported',
    refuseIds('setLeverageTooHigh', 'setLeverageWouldLiquidate', 'setLeverageInsufficientMargin'),
    'Isolated live re-leverage within 10×; ledger add/release; >10× 400; missing 404; would-be liq / insufficient margin refuse without write',
  ),
  route('setMarginMode', 'refuse', refuseIds('setMarginMode'), 'Mounted 501 NotSupported — isolated-at-open only'),

  // ── Extensions beyond REST_ROUTES (positions + ADL disclosure doors)
  {
    name: 'openPosition',
    method: 'POST',
    path: '/api/v1/positions',
    auth: 'private',
    scope: 'trade:write',
    kind: 'supported',
    refuseArmIds: refuseIds(
      'callerPriceOnOpen',
      'crossMarginOnOpen',
      'leverageRequiredOnOpen',
      'identityLevelInsufficientOnOpen',
      'identityLevelUnavailableOnOpen',
      'futuresUnconfiguredOnOpen',
    ),
    notes: 'Open funded futures; mark entry only; leverage required (no 1x default); cross / unnamed profit pot refuse',
  },
  {
    name: 'closePosition',
    method: 'DELETE',
    path: '/api/v1/positions/:id',
    auth: 'private',
    scope: 'trade:write',
    kind: 'supported',
    refuseArmIds: refuseIds('callerPriceOnClose', 'cancelNotClose'),
    notes:
      'Cancel-shaped DELETE. Caller price 400. Otherwise trade.cancel_not_close and the margin pot is unchanged. Close is POST /positions/:id/close.',
  },
  {
    name: 'closePositionQuantity',
    method: 'POST',
    path: '/api/v1/positions/:id/close',
    auth: 'private',
    scope: 'trade:write',
    kind: 'supported',
    refuseArmIds: refuseIds('profitSourceUnconfiguredOnClose'),
    notes: 'Close route. Runs the atomic close. Winning close without a named pot is 403 NotSupported.',
  },
  {
    name: 'addIsolatedMargin',
    method: 'POST',
    path: '/api/v1/positions/margin',
    auth: 'private',
    scope: 'trade:write',
    kind: 'supported',
    refuseArmIds: refuseIds('addIsolatedMarginInsufficient'),
    notes: 'Isolated extra collateral via futuresMarginAdd; leverage and margin mode unchanged; insufficient 400; missing 404',
  },
  {
    name: 'reduceIsolatedMargin',
    method: 'POST',
    path: '/api/v1/positions/margin/reduce',
    auth: 'private',
    scope: 'trade:write',
    kind: 'supported',
    refuseArmIds: refuseIds('reduceIsolatedMarginBelowInitial', 'reduceIsolatedMarginWouldLiquidate'),
    notes: 'Isolated excess out via futuresMarginRelease; cannot pull below IM; would-be liq 400; leverage unchanged',
  },
  {
    name: 'fetchClosedPositions',
    method: 'GET',
    path: '/api/v1/positions/closed',
    auth: 'private',
    scope: 'trade:read',
    kind: 'supported',
    refuseArmIds: [],
    notes: 'Closed/liquidated futures rows; [] when none; optional symbol/limit/since in SQL — no invented mark',
  },
  {
    name: 'fetchPosition',
    method: 'GET',
    path: '/api/v1/positions/:id',
    auth: 'private',
    scope: 'trade:read',
    kind: 'supported',
    refuseArmIds: [],
    notes: 'One owned futures row; missing/not theirs 404; closed is still a row — no invented mark',
  },
  {
    name: 'fetchPositionMarginCall',
    method: 'GET',
    path: '/api/v1/positions/:id/margin-call',
    auth: 'private',
    scope: 'trade:read',
    kind: 'supported',
    refuseArmIds: [],
    notes: 'Delivered futures margin call (MVP-2); 404 when none open — never invents',
  },
  {
    name: 'fetchAdlDisclosure',
    method: 'GET',
    path: '/api/v1/futures/adl-disclosure',
    auth: 'private',
    scope: 'trade:read',
    kind: 'supported',
    refuseArmIds: [],
    notes: 'In-product auto-deleveraging disclosure and whether this account has acknowledged it',
  },
  {
    name: 'ackAdlDisclosure',
    method: 'POST',
    path: '/api/v1/futures/adl-disclosure/ack',
    auth: 'private',
    scope: 'trade:write',
    kind: 'supported',
    refuseArmIds: [],
    notes: 'Voluntary ack of the current ADL disclosure version; no open waits on it',
  },
  {
    name: 'fetchAdlDisclosureEvents',
    method: 'GET',
    path: '/api/v1/futures/adl-events',
    auth: 'private',
    scope: 'trade:read',
    kind: 'supported',
    refuseArmIds: [],
    notes: 'Disclosure-before-action events for this principal — no silent ADL',
  },
  {
    name: 'previewOrder',
    method: 'POST',
    path: '/api/v1/orders/preview',
    auth: 'private',
    scope: 'trade:read',
    kind: 'supported',
    refuseArmIds: [],
    notes: 'Read-only spot place preview (hold/fee/refusals as decimal strings). No ledger port, no matching submit.',
  },
  {
    name: 'batchAmendOrders',
    method: 'POST',
    path: '/api/v1/orders/batch-amend',
    auth: 'private',
    scope: 'trade:write',
    kind: 'supported',
    refuseArmIds: [],
    notes:
      'Bounded sequential native amend (same PATCH path per item). Per-item APPLIED/REFUSED/OUTCOME_UNKNOWN. Non-atomic. Never silent cancel/replace.',
  },
  {
    name: 'cancelAllOrdersAfter',
    method: 'POST',
    path: '/api/v1/orders/cancel-all-after',
    auth: 'private',
    scope: 'trade:write',
    kind: 'supported',
    refuseArmIds: [],
    notes:
      'Dead-man switch. Body {timeout: seconds}; timeout 0 disarms. Allowed timeouts are the owner-published set (blank = refuse); the credential must outlive the deadline.',
  },
  {
    name: 'fetchCancelAllAfter',
    method: 'GET',
    path: '/api/v1/orders/cancel-all-after',
    auth: 'private',
    scope: 'trade:read',
    kind: 'supported',
    refuseArmIds: [],
    notes: "The caller's dead-man switch (armed, timeout, triggerTime) and the owner-published timeouts (null while unpublished).",
  },
  {
    name: 'fetchLedger',
    method: 'GET',
    path: '/api/v1/ledger',
    auth: 'private',
    scope: 'trade:read',
    kind: 'supported',
    refuseArmIds: [],
    notes:
      "The caller's balance changes, newest first, from svc-ledger: limit 1..200 required (blank refuses), optional code and cursor; each line carries its ledger transaction (referenceId) and entry id.",
  },
  {
    name: 'createStatementExport',
    method: 'POST',
    path: '/api/v1/statements',
    auth: 'private',
    scope: 'trade:read',
    kind: 'supported',
    refuseArmIds: [],
    notes:
      "A statement of the caller's orders, trades and ledger lines for a finished range. Body {from, to, requestKey}; one job per key (the same key answers the same job, another range refuses).",
  },
  {
    name: 'fetchStatementExport',
    method: 'GET',
    path: '/api/v1/statements/:id',
    auth: 'private',
    scope: 'trade:read',
    kind: 'supported',
    refuseArmIds: [],
    notes: "One of the caller's statement jobs; another person's reads as not found.",
  },
  {
    name: 'fetchStatementExportFile',
    method: 'GET',
    path: '/api/v1/statements/:id/file',
    auth: 'private',
    scope: 'trade:read',
    kind: 'supported',
    refuseArmIds: [],
    notes: "The finished statement's CSV, with its SHA-256 in x-intafaced-sha256.",
  },
  {
    name: 'batchCancelOrders',
    method: 'POST',
    path: '/api/v1/orders/batch-cancel',
    auth: 'private',
    scope: 'trade:write',
    kind: 'supported',
    refuseArmIds: [],
    notes:
      'Bounded sequential cancel by order id list (same path as DELETE /orders/:id per item). Per-item success/refused/unknown. Non-atomic.',
  },
  {
    name: 'massCancelOrders',
    method: 'POST',
    path: '/api/v1/markets/:marketId/orders/mass-cancel',
    auth: 'private',
    scope: 'trade:write',
    kind: 'supported',
    refuseArmIds: [],
    notes: 'Matching mass-cancel for the authenticated account on one market. Unauth and foreign account refuse. Never invents a session.',
  },
] as const;

/** Lookup refuse arm by stable id. */
export function refuseArmById(id: string): CcxtRefuseArm | undefined {
  return CCXT_REFUSE_ARMS.find((a) => a.id === id);
}

/** All matrix rows that are pure refuse mounts. */
export function refuseOnlyRoutes(): readonly CcxtCapabilityRow[] {
  return CCXT_CAPABILITY_MATRIX.filter((r) => r.kind === 'refuse');
}

/** REST_ROUTES names claimed by the matrix (excludes open/close extensions). */
export function matrixRestRouteNames(): readonly string[] {
  return CCXT_CAPABILITY_MATRIX.filter((r) => r.name in REST_ROUTES).map((r) => r.name);
}

/** Every refuse arm id referenced by the matrix exists in CCXT_REFUSE_ARMS. */
export function danglingRefuseArmIds(): readonly string[] {
  const known = new Set(CCXT_REFUSE_ARMS.map((a) => a.id));
  const dangling: string[] = [];
  for (const row of CCXT_CAPABILITY_MATRIX) {
    for (const id of row.refuseArmIds) {
      if (!known.has(id)) dangling.push(`${row.name}:${id}`);
    }
  }
  return dangling;
}

/** Refuse arms that no matrix row points at (orphan inventory). */
export function orphanRefuseArmIds(): readonly string[] {
  const used = new Set(CCXT_CAPABILITY_MATRIX.flatMap((r) => [...r.refuseArmIds]));
  return CCXT_REFUSE_ARMS.filter((a) => !used.has(a.id)).map((a) => a.id);
}

/**
 * Live margin-mode change — always refuse. Isolated re-leverage is supported.
 */
export const CCXT_LEVERAGE_REFUSE_IDS = ['setMarginMode'] as const;

export type CcxtLeverageRefuseId = (typeof CCXT_LEVERAGE_REFUSE_IDS)[number];

/**
 * Drift strings if setMarginMode is claimed as a happy path
 * (supported/conditional) or anything other than 501 NotSupported.
 * Empty = pin holds.
 */
export function leverageRefuseDrift(): readonly string[] {
  const drift: string[] = [];
  for (const id of CCXT_LEVERAGE_REFUSE_IDS) {
    const arm = refuseArmById(id);
    if (!arm) {
      drift.push(`${id}: missing refuse arm`);
      continue;
    }
    if (arm.httpStatus !== 501) drift.push(`${id}: httpStatus ${arm.httpStatus} (want 501)`);
    if (arm.ccxtCode !== 'NotSupported') drift.push(`${id}: ccxtCode ${arm.ccxtCode} (want NotSupported)`);
    const row = CCXT_CAPABILITY_MATRIX.find((r) => r.name === id);
    if (!row) {
      drift.push(`${id}: missing matrix row`);
      continue;
    }
    if (row.kind !== 'refuse') {
      drift.push(`${id}: kind ${row.kind} (must be refuse — never a 200 happy path)`);
    }
    if (!row.refuseArmIds.includes(id)) {
      drift.push(`${id}: matrix row does not reference its refuse arm`);
    }
  }
  return drift;
}
