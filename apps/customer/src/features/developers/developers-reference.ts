/**
 * The trading API as the developer pages publish it: every route and stream, its product, the permission a key needs,
 * what one call costs and the refusals every caller can meet. Nothing here is invented. It mirrors, and
 * `developers-reference.test.ts` checks it against, these sources:
 *
 * - the contract route table and channel table, `REST_ROUTES` and `WS_CHANNELS` in `packages/exchange-contract/src/api.ts`
 *   (the browser build cannot import that package's root, so the rows are copied and the test fails when they drift);
 * - svc-trade's route inventory, `GET /api/v1/routes` (`services/svc-trade/src/route-inventory.ts`): every `/api/v1`
 *   route as svc-trade mounts it, each once, with the access and the scopes its registration declares. svc-trade refuses
 *   to boot a route without a declaration, so that list is every route. The test reads the declarations in the source;
 *   the journey reads the live list and makes a signed-out call to each route;
 * - the key plane in svc-edge: `requiredScopeFor` in `services/svc-edge/src/gateway-plane.ts` (a key needs `trade:read`
 *   for a read and `trade:write` for anything else on `/api/v1`), and `EDGE_RATE_COST` in `services/svc-edge/src/hardening.ts`
 *   (every counted request costs 1; there are no per-route weights);
 * - svc-trade's capability matrix, `CCXT_CAPABILITY_MATRIX` in `services/svc-trade/src/ccxt-capability-matrix.ts`, for
 *   the refusals named beyond the ones every route shares.
 */

export type Product = 'general' | 'spot' | 'derivatives' | 'funding' | 'accounts';
export const PRODUCTS: readonly Product[] = ['general', 'spot', 'derivatives', 'funding', 'accounts'];

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/** The scope the edge asks a key for on a method. */
export type MethodScope = 'trade:read' | 'trade:write';
export type Scope = MethodScope | 'admin:read';
/** Who may call a route, as its registration declares: anyone, a signed caller, or another service only. */
export type Access = 'public' | 'private' | 'internal';

/** What svc-trade answers a caller with no credential: 401, with `code` in the body field `field`. */
export type SignedOut = { status: 401; field: 'intafacedCode' | 'error' | 'code'; code: string };
/** The private REST refusal (`requirePrincipal` in services/svc-trade/src/private-rest.ts). */
export const AUTH_REQUIRED: SignedOut = { status: 401, field: 'intafacedCode', code: 'auth.required' };
/** The doors that answer `{ error, message }`: conditional orders, previews, outcomes and others. */
export const TRADE_UNAUTHENTICATED: SignedOut = { status: 401, field: 'error', code: 'trade.unauthenticated' };
/** The same code in a `code` field: the fee tier and VIP applications. */
export const TRADE_UNAUTHENTICATED_CODE: SignedOut = { status: 401, field: 'code', code: 'trade.unauthenticated' };
/** A service-to-service route asked without a service signature. */
export const SERVICE_CREDENTIALS_REQUIRED: SignedOut = TRADE_UNAUTHENTICATED;

export type RestRoute = {
  /** The CCXT-style method name; the contract table's key where the route is in it. */
  name: string;
  method: Method;
  path: string;
  product: Product;
  /** Who may call it, as its registration in svc-trade declares (`GET /api/v1/routes`). */
  access: Access;
  /** Scopes a key needs beyond its method's (an admin read). */
  alsoNeeds?: readonly Scope[];
  /** The refusal a signed-out caller gets where it is not `AUTH_REQUIRED`; a public route has none. */
  signedOut?: SignedOut;
  /** Mounted only while futures orders go through matching (`TRADE_FUTURES_MATCHING_ENABLED`); otherwise not found. */
  onlyWithFuturesMatching?: true;
  /** The signed-out refusal while futures matching is off, when the resting-order refusal answers this route instead. */
  signedOutWithoutMatching?: SignedOut;
  /** One line for the machine-readable file. */
  summary: string;
  /** Refusals named in svc-trade's capability matrix for this route, beyond the ones every route shares. */
  refusals?: readonly { status: '400' | '501'; codes: readonly string[] }[];
};

/** Every counted request costs 1 against the key's (or the address's) bucket at the edge: `EDGE_RATE_COST`. */
export const CALL_COST = 1;

/**
 * Whether a clock this far from the server's (ms, either way) still signs a timestamp the server accepts, given the
 * owner's window in seconds as identity publishes it (`requestSigningPolicy`, DV-auth-01). Within the window even at
 * the far edge of the reading: the offset is known only to half a round trip either way.
 */
export const withinWindow = (offsetMs: number, roundTripMs: number, windowSeconds: number) =>
  Math.abs(offsetMs) + roundTripMs / 2 <= windowSeconds * 1000;

/** A key on `/api/v1` needs `trade:read` for a read and `trade:write` for every other method (`requiredScopeFor`). */
export const scopeFor = (method: Method): MethodScope => (method === 'GET' ? 'trade:read' : 'trade:write');

/** Every scope a key needs on a route: its method's and any more it declares. A key never reaches an internal route. */
export const scopesOf = (route: Pick<RestRoute, 'method' | 'access' | 'alsoNeeds'>): readonly Scope[] =>
  route.access === 'internal' ? [] : [scopeFor(route.method), ...(route.alsoNeeds ?? [])];

/** What a signed-out caller gets on a route; a public route answers them. */
/** The scopes a key needs, joined for a table cell. */
export const scopeText = (route: RestRoute) => scopesOf(route).join(' + ');

export const signedOutOf = (route: Pick<RestRoute, 'access' | 'signedOut'>): SignedOut | null =>
  route.access === 'public' ? null : (route.signedOut ?? AUTH_REQUIRED);

export const REST_REFERENCE: readonly RestRoute[] = [
  // General
  {
    name: 'fetchTime',
    method: 'GET',
    path: '/api/v1/time',
    product: 'general',
    access: 'public',
    summary: 'Server time in Unix milliseconds',
  },
  {
    name: 'fetchCapabilities',
    method: 'GET',
    path: '/api/v1/capabilities',
    product: 'general',
    access: 'public',
    summary: 'The live inventory of routes, their refusals and the rate limit notes',
  },
  {
    name: 'fetchRoutes',
    method: 'GET',
    path: '/api/v1/routes',
    product: 'general',
    access: 'public',
    summary: 'Every /api/v1 route svc-trade mounts, each once, with who may call it and the scopes a key needs',
  },
  // Spot: public
  { name: 'fetchMarkets', method: 'GET', path: '/api/v1/markets', product: 'spot', access: 'public', summary: 'Listed markets' },
  {
    name: 'fetchTicker',
    method: 'GET',
    path: '/api/v1/ticker/:symbol',
    product: 'spot',
    access: 'public',
    summary: 'Best bid, ask and last trade of one market',
  },
  {
    name: 'fetchTickers',
    method: 'GET',
    path: '/api/v1/tickers',
    product: 'spot',
    access: 'public',
    summary: 'Tickers of every market with a book',
  },
  {
    name: 'fetchOrderBook',
    method: 'GET',
    path: '/api/v1/orderbook/:symbol',
    product: 'spot',
    access: 'public',
    summary: 'Order book depth of one market',
  },
  {
    name: 'fetchOHLCV',
    method: 'GET',
    path: '/api/v1/ohlcv/:symbol',
    product: 'spot',
    access: 'public',
    summary: 'Candles built from real fills',
  },
  {
    name: 'fetchTrades',
    method: 'GET',
    path: '/api/v1/trades/:symbol',
    product: 'spot',
    access: 'public',
    summary: 'Public trade tape of one market',
  },
  {
    name: 'fetchMarketHalt',
    method: 'GET',
    path: '/api/v1/market-halt/:symbol',
    product: 'spot',
    access: 'public',
    summary: 'Whether one market is halted',
  },
  {
    name: 'fetchMarketLifecycle',
    method: 'GET',
    path: '/api/v1/market-lifecycle/:symbol',
    product: 'spot',
    access: 'public',
    summary: 'Listing state of one market',
  },
  {
    name: 'fetchChartOwnerValues',
    method: 'GET',
    path: '/api/v1/charts/owner-values',
    product: 'spot',
    access: 'public',
    summary: 'Chart limits the owner has set; a blank one is null',
  },
  {
    name: 'fetchPublishedFees',
    method: 'GET',
    path: '/api/v1/fees/published',
    product: 'spot',
    access: 'public',
    summary: 'The published fee schedule per market, pair group and tier; an unpublished schedule refuses',
  },
  // Spot: private
  { name: 'createOrder', method: 'POST', path: '/api/v1/orders', product: 'spot', access: 'private', summary: 'Place an order' },
  {
    name: 'cancelOrder',
    method: 'DELETE',
    path: '/api/v1/orders/:id',
    product: 'spot',
    access: 'private',
    summary: 'Cancel one open order',
  },
  { name: 'cancelAllOrders', method: 'DELETE', path: '/api/v1/orders', product: 'spot', access: 'private', summary: 'Cancel open orders' },
  { name: 'fetchOrder', method: 'GET', path: '/api/v1/orders/:id', product: 'spot', access: 'private', summary: 'One order' },
  { name: 'fetchOpenOrders', method: 'GET', path: '/api/v1/orders/open', product: 'spot', access: 'private', summary: 'Open orders' },
  { name: 'fetchClosedOrders', method: 'GET', path: '/api/v1/orders/closed', product: 'spot', access: 'private', summary: 'Closed orders' },
  {
    name: 'previewOrder',
    method: 'POST',
    path: '/api/v1/orders/preview',
    product: 'spot',
    access: 'private',
    summary: 'What an order would hold and cost, and why it would be refused, without placing it',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'batchAmendOrders',
    method: 'POST',
    path: '/api/v1/orders/batch-amend',
    product: 'spot',
    access: 'private',
    summary: 'Amend several open orders one by one, with a result for each',
  },
  {
    name: 'batchCancelOrders',
    method: 'POST',
    path: '/api/v1/orders/batch-cancel',
    product: 'spot',
    access: 'private',
    summary: 'Cancel several orders by id one by one, with a result for each',
  },
  {
    name: 'massCancelOrders',
    method: 'POST',
    path: '/api/v1/markets/:marketId/orders/mass-cancel',
    product: 'spot',
    access: 'private',
    summary: 'Cancel the caller’s open orders in one market',
  },
  {
    name: 'cancelAllOrdersAfter',
    method: 'POST',
    path: '/api/v1/orders/cancel-all-after',
    product: 'spot',
    access: 'private',
    summary: 'Arm or disarm the switch that cancels every open order after a timeout',
  },
  {
    name: 'fetchCancelAllAfter',
    method: 'GET',
    path: '/api/v1/orders/cancel-all-after',
    product: 'spot',
    access: 'private',
    summary: 'Whether the cancel-all switch is armed, and the timeouts allowed',
  },
  {
    name: 'createOrders',
    method: 'POST',
    path: '/api/v1/orders/batch',
    product: 'spot',
    access: 'private',
    summary: 'Place several orders one by one, with a result for each',
  },
  {
    name: 'editOrder',
    method: 'PATCH',
    path: '/api/v1/orders/:id',
    product: 'spot',
    access: 'private',
    summary: 'Amend an open order in the book; a change of side, market or price is named a cancel and replace',
  },
  {
    name: 'replaceOrder',
    method: 'POST',
    path: '/api/v1/orders/:id/replace',
    product: 'spot',
    access: 'private',
    summary: 'Cancel an open order, then place its replacement once the cancel has settled',
  },
  {
    name: 'fetchOrderAmendments',
    method: 'GET',
    path: '/api/v1/orders/:id/amendments',
    product: 'spot',
    access: 'private',
    summary: 'Each amend and replace of one order, oldest first',
  },
  {
    name: 'fetchOrderTrades',
    method: 'GET',
    path: '/api/v1/orders/:id/trades',
    product: 'spot',
    access: 'private',
    summary: 'One order’s fills, oldest first, each with its role, fee and fee rate',
  },
  {
    name: 'fetchOrderByClientId',
    method: 'GET',
    path: '/api/v1/orders/by-client-id/:clientOrderId',
    product: 'spot',
    access: 'private',
    summary: 'One order by its client order id; symbol is required',
  },
  {
    name: 'fetchOrderByClient',
    method: 'GET',
    path: '/api/v1/orders/by-client/:clientOrderId',
    product: 'spot',
    access: 'private',
    summary: 'The same read under its shorter path',
  },
  {
    name: 'cancelOrderByClientId',
    method: 'DELETE',
    path: '/api/v1/orders/by-client-id/:clientOrderId',
    product: 'spot',
    access: 'private',
    summary: 'Cancel one open order by its client order id; symbol is required',
  },
  {
    name: 'cancelOrderByClient',
    method: 'DELETE',
    path: '/api/v1/orders/by-client/:clientOrderId',
    product: 'spot',
    access: 'private',
    summary: 'The same cancel under its shorter path',
  },
  {
    name: 'closeSpotPosition',
    method: 'POST',
    path: '/api/v1/spot/positions/close',
    product: 'spot',
    access: 'private',
    summary: 'Flatten a spot position through the matching engine; a flat position refuses',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'previewPromotion',
    method: 'POST',
    path: '/api/v1/promotions',
    product: 'spot',
    access: 'private',
    summary: 'Preview a promotion; nothing is created and nothing moves',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'previewLiveDeploy',
    method: 'POST',
    path: '/api/v1/quant/live-deploy',
    product: 'spot',
    access: 'private',
    summary: 'Preview putting a strategy live; it never launches one',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  // Derivatives
  {
    name: 'fetchFundingRate',
    method: 'GET',
    path: '/api/v1/funding-rate/:symbol',
    product: 'derivatives',
    access: 'public',
    summary: 'Published funding rate of one futures market',
    refusals: [{ status: '501', codes: ['trade.funding_rate_spot_market', 'trade.funding_rate_unavailable'] }],
  },
  {
    name: 'fetchFuturesOrderTypes',
    method: 'GET',
    path: '/api/v1/futures/order-types',
    product: 'derivatives',
    access: 'public',
    summary: 'Order types, time in force and flags per futures market',
  },
  {
    name: 'fetchFundingRateHistory',
    method: 'GET',
    path: '/api/v1/funding-history/:symbol',
    product: 'derivatives',
    access: 'public',
    summary: 'Funding rate history of one futures market',
  },
  {
    name: 'fetchFuturesTicker',
    method: 'GET',
    path: '/api/v1/futures/ticker',
    product: 'derivatives',
    access: 'public',
    summary: 'The futures strip; a market fact not yet known is null',
  },
  {
    name: 'fetchLeverageTiers',
    method: 'GET',
    path: '/api/v1/futures/tiers',
    product: 'derivatives',
    access: 'public',
    summary: 'The leverage and margin tiers per futures market, as published',
  },
  {
    name: 'fetchOutcomeMarkets',
    method: 'GET',
    path: '/api/v1/outcomes/markets',
    product: 'derivatives',
    access: 'public',
    summary: 'Listed outcome markets',
  },
  {
    name: 'fetchPositions',
    method: 'GET',
    path: '/api/v1/positions',
    product: 'derivatives',
    access: 'private',
    summary: 'Open positions',
  },
  {
    name: 'fetchClosedPositions',
    method: 'GET',
    path: '/api/v1/positions/closed',
    product: 'derivatives',
    access: 'private',
    summary: 'Closed and liquidated positions',
  },
  {
    name: 'fetchPosition',
    method: 'GET',
    path: '/api/v1/positions/:id',
    product: 'derivatives',
    access: 'private',
    summary: 'One position',
  },
  {
    name: 'fetchPositionMarginCall',
    method: 'GET',
    path: '/api/v1/positions/:id/margin-call',
    product: 'derivatives',
    access: 'private',
    summary: 'The margin call open on one position',
  },
  {
    name: 'openPosition',
    method: 'POST',
    path: '/api/v1/positions',
    product: 'derivatives',
    access: 'private',
    summary: 'Open an isolated futures position at the mark, with the leverage named',
  },
  {
    name: 'closePositionQuantity',
    method: 'POST',
    path: '/api/v1/positions/:id/close',
    product: 'derivatives',
    access: 'private',
    summary: 'Close a position, in full or in part',
  },
  {
    name: 'closePosition',
    method: 'DELETE',
    path: '/api/v1/positions/:id',
    product: 'derivatives',
    access: 'private',
    summary: 'Mounted to refuse a cancel-shaped close; a position closes through its close route',
  },
  {
    name: 'addIsolatedMargin',
    method: 'POST',
    path: '/api/v1/positions/margin',
    product: 'derivatives',
    access: 'private',
    summary: 'Add collateral to an isolated position',
  },
  {
    name: 'reduceIsolatedMargin',
    method: 'POST',
    path: '/api/v1/positions/margin/reduce',
    product: 'derivatives',
    access: 'private',
    summary: 'Take excess collateral out of an isolated position',
  },
  {
    name: 'fetchAdlDisclosure',
    method: 'GET',
    path: '/api/v1/futures/adl-disclosure',
    product: 'derivatives',
    access: 'private',
    summary: 'The auto-deleveraging disclosure, and whether this account has acknowledged it',
  },
  {
    name: 'ackAdlDisclosure',
    method: 'POST',
    path: '/api/v1/futures/adl-disclosure/ack',
    product: 'derivatives',
    access: 'private',
    summary: 'Acknowledge the current auto-deleveraging disclosure',
  },
  {
    name: 'fetchAdlDisclosureEvents',
    method: 'GET',
    path: '/api/v1/futures/adl-events',
    product: 'derivatives',
    access: 'private',
    summary: 'Auto-deleveraging events disclosed to this account',
  },
  {
    name: 'setLeverage',
    method: 'POST',
    path: '/api/v1/positions/leverage',
    product: 'derivatives',
    access: 'private',
    summary: 'Change the leverage of an isolated position',
    refusals: [{ status: '400', codes: ['trade.leverage_too_high', 'trade.leverage_would_liquidate', 'trade.insufficient_margin'] }],
  },
  {
    name: 'setMarginMode',
    method: 'POST',
    path: '/api/v1/positions/margin-mode',
    product: 'derivatives',
    access: 'private',
    summary: 'Mounted only to refuse: margin mode is chosen when a position opens',
    refusals: [{ status: '501', codes: ['trade.margin_mode_unsupported'] }],
  },
  {
    name: 'fetchGatedList',
    method: 'GET',
    path: '/api/v1/account/gated-list',
    product: 'derivatives',
    access: 'private',
    summary: 'Each futures contract open or blocked for this account, with every reason',
  },
  {
    name: 'fetchPositionLiquidation',
    method: 'GET',
    path: '/api/v1/positions/:id/liquidation',
    product: 'derivatives',
    access: 'private',
    summary: 'The liquidation state of one position',
  },
  {
    name: 'fetchLiquidations',
    method: 'GET',
    path: '/api/v1/futures/liquidations',
    product: 'derivatives',
    access: 'private',
    summary: 'This account’s liquidation rungs',
  },
  {
    name: 'fetchFuturesPayouts',
    method: 'GET',
    path: '/api/v1/futures/payouts',
    product: 'derivatives',
    access: 'private',
    summary: 'This account’s profit payouts: paid, or owed while the clearing pot is short',
  },
  {
    name: 'fetchFundingPayments',
    method: 'GET',
    path: '/api/v1/positions/:id/funding-payments',
    product: 'derivatives',
    access: 'private',
    summary: 'Funding paid and received on one position',
  },
  {
    name: 'closeAllPositions',
    method: 'POST',
    path: '/api/v1/futures/positions/close-all',
    product: 'derivatives',
    access: 'private',
    summary: 'Close every open position, or those in one market; clientBatchId is required',
  },
  {
    name: 'fetchMarginSummary',
    method: 'GET',
    path: '/api/v1/futures/margin-summary',
    product: 'derivatives',
    access: 'private',
    summary: 'This account’s futures margin in one summary',
  },
  {
    name: 'fetchPositionMode',
    method: 'GET',
    path: '/api/v1/futures/position-mode',
    product: 'derivatives',
    access: 'private',
    summary: 'This account’s position mode',
  },
  {
    name: 'setPositionMode',
    method: 'PUT',
    path: '/api/v1/futures/position-mode',
    product: 'derivatives',
    access: 'private',
    summary: 'Change this account’s position mode',
  },
  {
    name: 'setFuturesLeverage',
    method: 'POST',
    path: '/api/v1/futures/leverage',
    product: 'derivatives',
    access: 'private',
    summary: 'The same leverage change as POST /api/v1/positions/leverage',
    refusals: [{ status: '400', codes: ['trade.leverage_too_high', 'trade.leverage_would_liquidate', 'trade.insufficient_margin'] }],
  },
  {
    name: 'calculateFuturesRisk',
    method: 'POST',
    path: '/api/v1/futures/calculator',
    product: 'derivatives',
    access: 'private',
    summary: 'Margin, liquidation price and tier for a position you describe; nothing is placed',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'fetchCollateral',
    method: 'GET',
    path: '/api/v1/futures/collateral',
    product: 'derivatives',
    access: 'private',
    summary: 'Collateral by class, the buying power it leaves, and the classes refused with their code',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'createConditionalOrder',
    method: 'POST',
    path: '/api/v1/futures/conditional-orders',
    product: 'derivatives',
    access: 'private',
    summary: 'Place a conditional order that arms on its trigger',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'fetchConditionalOrders',
    method: 'GET',
    path: '/api/v1/futures/conditional-orders',
    product: 'derivatives',
    access: 'private',
    summary: 'This account’s conditional orders',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'fetchConditionalOrder',
    method: 'GET',
    path: '/api/v1/futures/conditional-orders/:id',
    product: 'derivatives',
    access: 'private',
    summary: 'One conditional order',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'cancelConditionalOrder',
    method: 'DELETE',
    path: '/api/v1/futures/conditional-orders/:id',
    product: 'derivatives',
    access: 'private',
    summary: 'Cancel one conditional order',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'setPositionProtection',
    method: 'PUT',
    path: '/api/v1/positions/:id/protection',
    product: 'derivatives',
    access: 'private',
    summary: 'Set the protective orders of one position',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'fetchEntryProtection',
    method: 'GET',
    path: '/api/v1/futures/entry-protection',
    product: 'derivatives',
    access: 'private',
    summary: 'What each opening order asked to be protected with, and how far its legs have armed',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'createFuturesOrder',
    method: 'POST',
    path: '/api/v1/futures/orders',
    product: 'derivatives',
    access: 'private',
    summary: 'Place a futures order in the book',
    signedOutWithoutMatching: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'fetchFuturesOrders',
    method: 'GET',
    path: '/api/v1/futures/orders',
    product: 'derivatives',
    access: 'private',
    summary: 'This account’s futures orders',
    signedOutWithoutMatching: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'cancelFuturesOrder',
    method: 'DELETE',
    path: '/api/v1/futures/orders/:id',
    product: 'derivatives',
    access: 'private',
    summary: 'Cancel one futures order',
    signedOutWithoutMatching: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'createSplitFuturesOrder',
    method: 'POST',
    path: '/api/v1/futures/orders/split',
    product: 'derivatives',
    access: 'private',
    summary: 'Place one futures order as several children; the answer lists each child placed',
    onlyWithFuturesMatching: true,
  },
  {
    name: 'reversePosition',
    method: 'POST',
    path: '/api/v1/positions/:id/reverse',
    product: 'derivatives',
    access: 'private',
    summary: 'Close a position and open the opposite one; the same request id never places a leg twice',
    onlyWithFuturesMatching: true,
  },
  {
    name: 'previewPosition',
    method: 'POST',
    path: '/api/v1/positions/preview',
    product: 'derivatives',
    access: 'private',
    summary: 'The risk of a futures position before it opens; nothing is placed',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'previewGreeksWhatIf',
    method: 'POST',
    path: '/api/v1/greeks/what-if',
    product: 'derivatives',
    access: 'private',
    summary: 'Option greeks under a what-if; nothing is placed',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'previewDeltaHedge',
    method: 'POST',
    path: '/api/v1/greeks/delta-hedge',
    product: 'derivatives',
    access: 'private',
    summary: 'The orders a delta hedge would place; none is placed',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'createOutcomeOrder',
    method: 'POST',
    path: '/api/v1/outcomes/orders',
    product: 'derivatives',
    access: 'private',
    summary: 'Place an order on an outcome market',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'settleOutcomeMarket',
    method: 'POST',
    path: '/api/v1/outcomes/settle',
    product: 'derivatives',
    access: 'internal',
    summary: 'Service to service only: settle an outcome market. No key or session reaches it',
    signedOut: SERVICE_CREDENTIALS_REQUIRED,
  },
  // Accounts
  {
    name: 'fetchBalance',
    method: 'GET',
    path: '/api/v1/account/balance',
    product: 'accounts',
    access: 'private',
    summary: 'Account balances',
  },
  {
    name: 'fetchTradingFees',
    method: 'GET',
    path: '/api/v1/account/fees',
    product: 'accounts',
    access: 'private',
    summary: 'Maker and taker fee rates',
  },
  {
    name: 'fetchMyTrades',
    method: 'GET',
    path: '/api/v1/account/trades',
    product: 'accounts',
    access: 'private',
    summary: 'The account’s own fills',
  },
  {
    name: 'fetchLedger',
    method: 'GET',
    path: '/api/v1/ledger',
    product: 'accounts',
    access: 'private',
    summary: 'The account’s balance changes, newest first',
  },
  {
    name: 'createStatementExport',
    method: 'POST',
    path: '/api/v1/statements',
    product: 'accounts',
    access: 'private',
    summary: 'Ask for a statement of orders, trades and balance changes over a finished range',
  },
  {
    name: 'fetchStatementExport',
    method: 'GET',
    path: '/api/v1/statements/:id',
    product: 'accounts',
    access: 'private',
    summary: 'One statement request and its state',
  },
  {
    name: 'fetchStatementExportFile',
    method: 'GET',
    path: '/api/v1/statements/:id/file',
    product: 'accounts',
    access: 'private',
    summary: 'A finished statement as a CSV file',
  },
  {
    name: 'fetchFeeTier',
    method: 'GET',
    path: '/api/v1/account/fee-tier',
    product: 'accounts',
    access: 'private',
    summary: 'This account’s fee tier',
    signedOut: TRADE_UNAUTHENTICATED_CODE,
  },
  {
    name: 'fetchAccountMarketLifecycle',
    method: 'GET',
    path: '/api/v1/account/market-lifecycle/:symbol',
    product: 'accounts',
    access: 'private',
    summary: 'The listing state of one market as this account meets it',
  },
  {
    name: 'fetchConvertExport',
    method: 'GET',
    path: '/api/v1/convert/export',
    product: 'accounts',
    access: 'private',
    summary: 'This account’s convert history as a CSV file',
  },
  {
    name: 'fetchCopyExport',
    method: 'GET',
    path: '/api/v1/copy/export',
    product: 'accounts',
    access: 'private',
    summary: 'This account’s copy-trading history as a CSV file',
  },
  {
    name: 'fetchRfqExport',
    method: 'GET',
    path: '/api/v1/rfq/export',
    product: 'accounts',
    access: 'private',
    summary: 'This account’s request-for-quote history as a CSV file',
  },
  {
    name: 'fetchGridBots',
    method: 'GET',
    path: '/api/v1/bots/grid',
    product: 'spot',
    access: 'private',
    summary: 'This account’s spot grid bots',
    signedOut: TRADE_UNAUTHENTICATED_CODE,
  },
  {
    name: 'fetchGridBot',
    method: 'GET',
    path: '/api/v1/bots/grid/:id',
    product: 'spot',
    access: 'private',
    summary: 'One spot grid bot, with its levels and orders',
    signedOut: TRADE_UNAUTHENTICATED_CODE,
  },
  {
    name: 'createGridBot',
    method: 'POST',
    path: '/api/v1/bots/grid',
    product: 'spot',
    access: 'private',
    summary: 'Start a neutral spot grid bot; the same clientId returns the same bot',
    signedOut: TRADE_UNAUTHENTICATED_CODE,
  },
  {
    name: 'stopGridBot',
    method: 'POST',
    path: '/api/v1/bots/grid/:id/stop',
    product: 'spot',
    access: 'private',
    summary: 'Stop a grid bot; what it bought stays in the balance (settlement keep)',
    signedOut: TRADE_UNAUTHENTICATED_CODE,
  },
  {
    name: 'withdrawGridProfit',
    method: 'POST',
    path: '/api/v1/bots/grid/:id/withdraw',
    product: 'spot',
    access: 'private',
    summary: 'Withdraw a grid bot’s profit; needs a step-up confirmation (403 identity.step_up_required without one)',
    signedOut: TRADE_UNAUTHENTICATED_CODE,
  },
  {
    name: 'fetchVipApplications',
    method: 'GET',
    path: '/api/v1/vip/applications',
    product: 'accounts',
    access: 'private',
    summary: 'This account’s VIP applications',
    signedOut: TRADE_UNAUTHENTICATED_CODE,
  },
  {
    name: 'applyForVip',
    method: 'POST',
    path: '/api/v1/vip/applications',
    product: 'accounts',
    access: 'private',
    summary: 'Apply for a VIP tier',
    signedOut: TRADE_UNAUTHENTICATED_CODE,
  },
  {
    name: 'fetchAdminOpenOrders',
    method: 'GET',
    path: '/api/v1/admin/orders/open',
    product: 'accounts',
    access: 'private',
    summary: 'Staff only: open orders across accounts',
    alsoNeeds: ['admin:read'],
  },
  {
    name: 'fetchAdminFees',
    method: 'GET',
    path: '/api/v1/admin/fees',
    product: 'accounts',
    access: 'private',
    summary: 'Staff only: the fee schedule customers are charged, per market, with its source',
    alsoNeeds: ['admin:read'],
  },
];

/** svc-ws's four doors: one market per socket, many channels on one socket, the account's own lifecycle, and the drop copy. */
export const STREAM_DOORS = ['market', 'mux', 'private', 'drop-copy'] as const;
export type StreamDoor = (typeof STREAM_DOORS)[number];
export const STREAM_DOOR_PATH: Readonly<Record<StreamDoor, string>> = {
  market: '/stream',
  mux: '/stream',
  private: '/private/stream',
  'drop-copy': '/drop-copy/stream',
};

export type Stream = { door: StreamDoor; channel: string; product: Product; private: boolean };

/**
 * Every channel svc-ws serves, by door and product, as its live inventory (`GET /ws/streams`) lists them. A private
 * channel carries only the signed-in principal's own data. `futures.mark.` takes a listing symbol after it.
 */
export const STREAM_REFERENCE: readonly Stream[] = [
  { door: 'market', channel: 'depth', product: 'spot', private: false },
  { door: 'market', channel: 'trades', product: 'spot', private: false },
  { door: 'mux', channel: 'book', product: 'spot', private: false },
  { door: 'mux', channel: 'trades', product: 'spot', private: false },
  { door: 'mux', channel: 'ticker', product: 'spot', private: false },
  { door: 'mux', channel: 'candles', product: 'spot', private: false },
  { door: 'mux', channel: 'futures.mark.', product: 'derivatives', private: false },
  { door: 'private', channel: 'orders', product: 'spot', private: true },
  { door: 'private', channel: 'fills', product: 'spot', private: true },
  { door: 'private', channel: 'positions', product: 'derivatives', private: true },
  { door: 'drop-copy', channel: 'drop_copy', product: 'accounts', private: true },
];

/** How a stream is named on the page: the channel, with the symbol placeholder where it takes one. */
export const streamName = (stream: Pick<Stream, 'channel'>) =>
  stream.channel.endsWith('.') ? `${stream.channel}<symbol>` : stream.channel;

/**
 * Scopes that never reach a key (`INTERACTIVE_ONLY_SCOPES` in packages/auth). admin:read is held only by a staff session,
 * so a key is refused on every staff route; withdrawing is not reachable from the API at all.
 */
export const NEVER_ON_A_KEY = ['admin:read', 'trade:withdraw'] as const;
const neverOnAKey = (route: RestRoute) => scopesOf(route).some((scope) => (NEVER_ON_A_KEY as readonly string[]).includes(scope));

export const routeLine = (route: Pick<RestRoute, 'method' | 'path'>) => `${route.method} ${route.path}`;

/** The permission-to-endpoint table: one row per scope a key can hold, with every route a key with it may call. */
export function permissionTable(): { scope: Scope; routes: RestRoute[] }[] {
  return (['trade:read', 'trade:write'] as const).map((scope) => ({
    scope,
    routes: REST_REFERENCE.filter((route) => !neverOnAKey(route) && scopesOf(route).includes(scope)),
  }));
}

/** The scopes no key holds, each with the routes that need it: the staff routes for admin:read, none for withdrawing. */
export function neverOnAKeyTable(): { scope: (typeof NEVER_ON_A_KEY)[number]; routes: RestRoute[] }[] {
  return NEVER_ON_A_KEY.map((scope) => ({
    scope,
    routes: REST_REFERENCE.filter((route) => (scopesOf(route) as readonly string[]).includes(scope)),
  }));
}

const openApiPath = (path: string) => path.replace(/:(\w+)/g, '{$1}');
const pathParams = (path: string) => [...path.matchAll(/:(\w+)/g)].map((match) => match[1]!);
const refusalText = (refusal: SignedOut) => `401 with ${refusal.field} ${refusal.code}`;

/** The OpenAPI 3.0 document for the trading REST routes. No `servers`: no host is set, and none is guessed. */
export function openApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of REST_REFERENCE) {
    const scopes = scopesOf(route);
    const signedOut = signedOutOf(route);
    const responses: Record<string, { description: string }> = {
      '200': { description: 'Success' },
      ...(signedOut
        ? {
            '401': {
              description:
                route.access === 'internal'
                  ? `No service signature (${refusalText(signedOut)}); no key or session reaches this route`
                  : `No credential, or one that did not verify (${refusalText(signedOut)})`,
            },
          }
        : {}),
      ...(scopes.length
        ? {
            '403': {
              description: `An API key without ${scopes.join(' and ')} (PermissionDenied, scope.denied); the body links the permission table`,
            },
          }
        : {}),
      '429': { description: 'Over the rate limit (edge.rate_limited); retry after retryAfterSeconds' },
    };
    for (const refusal of route.refusals ?? []) responses[refusal.status] = { description: `Refused: ${refusal.codes.join(', ')}` };
    const params = pathParams(route.path);
    (paths[openApiPath(route.path)] ??= {})[route.method.toLowerCase()] = {
      operationId: route.name,
      summary: route.summary,
      tags: [route.product],
      ...(params.length ? { parameters: params.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })) } : {}),
      security: route.access === 'public' ? [{}, { apiKey: [] }] : route.access === 'private' ? [{ apiKey: [] }] : [],
      'x-access': route.access,
      'x-scopes': scopes,
      'x-signed-out': signedOut,
      ...(route.signedOutWithoutMatching ? { 'x-signed-out-without-futures-matching': route.signedOutWithoutMatching } : {}),
      ...(route.onlyWithFuturesMatching ? { 'x-only-with': 'futures-matching' } : {}),
      'x-cost': CALL_COST,
      responses,
    };
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'Trading API',
      version: 'v1',
      description:
        'Every trading REST route, each once, as GET /api/v1/routes lists it. x-access says who may call it: public answers ' +
        'without a key, private needs a key or a session, internal is service to service only. x-scopes is every permission ' +
        'an API key needs. x-signed-out is the refusal a caller with no credential gets: its status, the body field and the ' +
        'code. x-only-with futures-matching marks a route mounted only while futures orders go through matching. x-cost is ' +
        'what one call takes from the rate-limit bucket. Amounts are decimal strings. No server is listed: the owner has not ' +
        'set the hosts (see /developers/hosts).',
    },
    tags: PRODUCTS.map((name) => ({ name })),
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'An API key, sent as a bearer token' } },
    },
    paths,
  };
}

/** A request collection (the v2.1 collection format) of the same routes. The base address is a variable left blank. */
export function requestCollection() {
  return {
    info: {
      name: 'Trading API',
      description: 'Every trading REST route. Set baseUrl once the owner publishes a host (/developers/hosts); it is not set.',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    variable: [
      { key: 'baseUrl', value: '', description: 'host not set' },
      { key: 'apiKey', value: '', description: 'Your API key; never commit it' },
    ],
    item: PRODUCTS.map((product) => ({
      name: product,
      item: REST_REFERENCE.filter((route) => route.product === product).map((route) => ({
        name: route.name,
        ...(route.access === 'internal' ? { description: 'Service to service only; no key or session reaches it' } : {}),
        request: {
          method: route.method,
          header: route.access === 'private' ? [{ key: 'Authorization', value: 'Bearer {{apiKey}}' }] : [],
          url: {
            raw: `{{baseUrl}}${route.path}`,
            host: ['{{baseUrl}}'],
            path: route.path.split('/').filter(Boolean),
            ...(pathParams(route.path).length ? { variable: pathParams(route.path).map((key) => ({ key, value: '' })) } : {}),
          },
        },
      })),
    })),
  };
}
