/**
 * The trading API as the developer pages publish it: every route and stream, its product, the permission a key needs,
 * what one call costs and the refusals every caller can meet. Nothing here is invented. It mirrors, and
 * `developers-reference.test.ts` checks it against, these sources:
 *
 * - the contract route table and channel table, `REST_ROUTES` and `WS_CHANNELS` in `packages/exchange-contract/src/api.ts`
 *   (the browser build cannot import that package's root, so the rows are copied and the test fails when they drift);
 * - svc-trade's route inventory, `GET /api/v1/routes` (`services/svc-trade/src/route-inventory.ts`): every `/api/v1`
 *   route as svc-trade mounts it, each once, with the access and the scopes its registration declares. svc-trade refuses
 *   to boot a route without a declaration, so that list is every route. Each route's access and scopes are not written
 *   here: they come from `SERVED_ROUTES`, which `node tooling/ci/published-routes.mjs --write` generates from those
 *   registrations. A row here holds only a route's words; the journey reads the live list and makes a signed-out call
 *   to each route;
 * - the key plane in svc-edge: `requiredScopeFor` in `services/svc-edge/src/gateway-plane.ts` (a key needs `trade:read`
 *   for a read and `trade:write` for anything else on `/api/v1`), and `EDGE_RATE_COST` in `services/svc-edge/src/hardening.ts`
 *   (every counted request costs 1; there are no per-route weights);
 * - svc-trade's capability matrix, `CCXT_CAPABILITY_MATRIX` in `services/svc-trade/src/ccxt-capability-matrix.ts`, for
 *   the refusals named beyond the ones every route shares.
 */
import { SERVED_ROUTES } from './served-routes.generated';

export type Product = 'general' | 'spot' | 'derivatives' | 'funding' | 'accounts';
export const PRODUCTS: readonly Product[] = ['general', 'spot', 'derivatives', 'funding', 'accounts'];

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/** The scope the edge asks a key for on a method. */
export type MethodScope = 'trade:read' | 'trade:write';
export type Scope = MethodScope | 'admin:read' | 'copy:lead';
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

/** A route's words: what the portal says about a route svc-trade serves. */
export type RouteWords = {
  /** The CCXT-style method name; the contract table's key where the route is in it. */
  name: string;
  method: Method;
  path: string;
  product: Product;
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

/** A published route: its words, and who may call it and the scopes a key needs, as svc-trade's registration declares. */
export type RestRoute = RouteWords & { access: Access; scopes: readonly Scope[] };

/** `SERVED_ROUTES` by route: `GET /api/v1/time` to its access and scopes. */
const SERVED = new Map(
  SERVED_ROUTES.map((line) => {
    const [method, path, access, scopes] = line.split(' ');
    return [`${method} ${path}`, { access: access as Access, scopes: (scopes ? scopes.split('+') : []) as Scope[] }];
  }),
);

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

/** Every scope a key needs on a route, as its registration declares: its method's and any more. None on an internal route. */
export const scopesOf = (route: Pick<RestRoute, 'scopes'>): readonly Scope[] => route.scopes;

/** What a signed-out caller gets on a route; a public route answers them. */
/** The scopes a key needs, joined for a table cell. */
export const scopeText = (route: RestRoute) => scopesOf(route).join(' + ');

export const signedOutOf = (route: Pick<RestRoute, 'access' | 'signedOut'>): SignedOut | null =>
  route.access === 'public' ? null : (route.signedOut ?? AUTH_REQUIRED);

/** Every route's words. A route svc-trade no longer serves is not published; the test names it and every unworded route. */
export const ROUTE_WORDS: readonly RouteWords[] = [
  // General
  {
    name: 'fetchTime',
    method: 'GET',
    path: '/api/v1/time',
    product: 'general',

    summary: 'Server time in Unix milliseconds',
  },
  {
    name: 'fetchCapabilities',
    method: 'GET',
    path: '/api/v1/capabilities',
    product: 'general',

    summary: 'The live inventory of routes, their refusals and the rate limit notes',
  },
  {
    name: 'fetchRoutes',
    method: 'GET',
    path: '/api/v1/routes',
    product: 'general',

    summary: 'Every /api/v1 route svc-trade mounts, each once, with who may call it and the scopes a key needs',
  },
  // Spot: public
  { name: 'fetchMarkets', method: 'GET', path: '/api/v1/markets', product: 'spot', summary: 'Listed markets' },
  {
    name: 'fetchOrderTypes',
    method: 'GET',
    path: '/api/v1/order-types',
    product: 'spot',

    summary: 'The spot order types the ticket shows, how each is sent and its times in force, then each type refused',
  },
  {
    name: 'fetchTicker',
    method: 'GET',
    path: '/api/v1/ticker/:symbol',
    product: 'spot',

    summary: 'Best bid, ask and last trade of one market',
  },
  {
    name: 'fetchTickers',
    method: 'GET',
    path: '/api/v1/tickers',
    product: 'spot',

    summary: 'Tickers of every market with a book',
  },
  {
    name: 'fetchSpreads',
    method: 'GET',
    path: '/api/v1/spreads',
    product: 'spot',

    summary: 'The bid-ask spread of every market with a book',
  },
  {
    name: 'fetchMarketAnalytics',
    method: 'GET',
    path: '/api/v1/analytics/:symbol',
    product: 'spot',

    summary: 'One market’s aggressor differential and trade count over a named window',
  },
  {
    name: 'fetchOrderBook',
    method: 'GET',
    path: '/api/v1/orderbook/:symbol',
    product: 'spot',

    summary: 'Order book depth of one market',
  },
  {
    name: 'fetchOHLCV',
    method: 'GET',
    path: '/api/v1/ohlcv/:symbol',
    product: 'spot',

    summary: 'Candles built from real fills',
  },
  {
    name: 'fetchTrades',
    method: 'GET',
    path: '/api/v1/trades/:symbol',
    product: 'spot',

    summary: 'Public trade tape of one market',
  },
  {
    name: 'fetchMarketHalt',
    method: 'GET',
    path: '/api/v1/market-halt/:symbol',
    product: 'spot',

    summary: 'Whether one market is halted',
  },
  {
    name: 'fetchRulebook',
    method: 'GET',
    path: '/api/v1/rulebook',
    product: 'spot',

    summary: 'The trading rulebook in force, section by section',
  },
  {
    name: 'fetchRulebookVersions',
    method: 'GET',
    path: '/api/v1/rulebook/versions',
    product: 'spot',

    summary: 'Every published rulebook version and what each changed',
  },
  {
    name: 'fetchMarketLifecycle',
    method: 'GET',
    path: '/api/v1/market-lifecycle/:symbol',
    product: 'spot',

    summary: 'Listing state of one market',
  },
  {
    name: 'fetchChartOwnerValues',
    method: 'GET',
    path: '/api/v1/charts/owner-values',
    product: 'spot',

    summary: 'Chart limits the owner has set; a blank one is null',
  },
  {
    name: 'fetchPublishedFees',
    method: 'GET',
    path: '/api/v1/fees/published',
    product: 'spot',

    summary: 'The published fee schedule per market, pair group and tier; an unpublished schedule refuses',
  },
  // Spot: private
  { name: 'createOrder', method: 'POST', path: '/api/v1/orders', product: 'spot', summary: 'Place an order' },
  {
    name: 'createConvertQuote',
    method: 'POST',
    path: '/api/v1/convert/quote',
    product: 'spot',

    summary: 'A firm convert price for an amount of one coin into another; nothing is held',
  },
  {
    name: 'acceptConvertQuote',
    method: 'POST',
    path: '/api/v1/convert/accept',
    product: 'spot',

    summary: 'Convert at a quoted price; the same quote id again answers the same conversion',
  },
  {
    name: 'cancelOrder',
    method: 'DELETE',
    path: '/api/v1/orders/:id',
    product: 'spot',

    summary: 'Cancel one open order',
  },
  { name: 'cancelAllOrders', method: 'DELETE', path: '/api/v1/orders', product: 'spot', summary: 'Cancel open orders' },
  { name: 'fetchOrder', method: 'GET', path: '/api/v1/orders/:id', product: 'spot', summary: 'One order' },
  { name: 'fetchOpenOrders', method: 'GET', path: '/api/v1/orders/open', product: 'spot', summary: 'Open orders' },
  { name: 'fetchClosedOrders', method: 'GET', path: '/api/v1/orders/closed', product: 'spot', summary: 'Closed orders' },
  {
    name: 'previewOrder',
    method: 'POST',
    path: '/api/v1/orders/preview',
    product: 'spot',

    summary: 'What an order would hold and cost, and why it would be refused, without placing it',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'batchAmendOrders',
    method: 'POST',
    path: '/api/v1/orders/batch-amend',
    product: 'spot',

    summary: 'Amend several open orders one by one, with a result for each',
  },
  {
    name: 'batchCancelOrders',
    method: 'POST',
    path: '/api/v1/orders/batch-cancel',
    product: 'spot',

    summary: 'Cancel several orders by id one by one, with a result for each',
  },
  {
    name: 'massCancelOrders',
    method: 'POST',
    path: '/api/v1/markets/:marketId/orders/mass-cancel',
    product: 'spot',

    summary: 'Cancel the caller’s open orders in one market',
  },
  {
    name: 'cancelAllOrdersAfter',
    method: 'POST',
    path: '/api/v1/orders/cancel-all-after',
    product: 'spot',

    summary: 'Arm or disarm the switch that cancels every open order after a timeout',
  },
  {
    name: 'fetchCancelAllAfter',
    method: 'GET',
    path: '/api/v1/orders/cancel-all-after',
    product: 'spot',

    summary: 'Whether the cancel-all switch is armed, and the timeouts allowed',
  },
  {
    name: 'createOrders',
    method: 'POST',
    path: '/api/v1/orders/batch',
    product: 'spot',

    summary: 'Place several orders one by one, with a result for each',
  },
  {
    name: 'editOrder',
    method: 'PATCH',
    path: '/api/v1/orders/:id',
    product: 'spot',

    summary: 'Amend an open order in the book; a change of side, market or price is named a cancel and replace',
  },
  {
    name: 'replaceOrder',
    method: 'POST',
    path: '/api/v1/orders/:id/replace',
    product: 'spot',

    summary: 'Cancel an open order, then place its replacement once the cancel has settled',
  },
  {
    name: 'fetchOrderAmendments',
    method: 'GET',
    path: '/api/v1/orders/:id/amendments',
    product: 'spot',

    summary: 'Each amend and replace of one order, oldest first',
  },
  {
    name: 'fetchOrderQueuePosition',
    method: 'GET',
    path: '/api/v1/orders/:id/queue',
    product: 'spot',

    summary: 'Orders and size ahead of one of your resting orders in the matching queue, with a fill estimate when the window is set',
  },
  {
    name: 'fetchOrderTrades',
    method: 'GET',
    path: '/api/v1/orders/:id/trades',
    product: 'spot',

    summary: 'One order’s fills, oldest first, each with its role, fee and fee rate',
  },
  {
    name: 'fetchOrderByClientId',
    method: 'GET',
    path: '/api/v1/orders/by-client-id/:clientOrderId',
    product: 'spot',

    summary: 'One order by its client order id; symbol is required',
  },
  {
    name: 'fetchOrderByClient',
    method: 'GET',
    path: '/api/v1/orders/by-client/:clientOrderId',
    product: 'spot',

    summary: 'The same read under its shorter path',
  },
  {
    name: 'cancelOrderByClientId',
    method: 'DELETE',
    path: '/api/v1/orders/by-client-id/:clientOrderId',
    product: 'spot',

    summary: 'Cancel one open order by its client order id; symbol is required',
  },
  {
    name: 'cancelOrderByClient',
    method: 'DELETE',
    path: '/api/v1/orders/by-client/:clientOrderId',
    product: 'spot',

    summary: 'The same cancel under its shorter path',
  },
  {
    name: 'closeSpotPosition',
    method: 'POST',
    path: '/api/v1/spot/positions/close',
    product: 'spot',

    summary: 'Flatten a spot position through the matching engine; a flat position refuses',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'previewPromotion',
    method: 'POST',
    path: '/api/v1/promotions',
    product: 'spot',

    summary: 'Preview a promotion; nothing is created and nothing moves',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'previewLiveDeploy',
    method: 'POST',
    path: '/api/v1/quant/live-deploy',
    product: 'spot',

    summary: 'Preview putting a strategy live; it never launches one',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'postSignalAlert',
    method: 'POST',
    path: '/api/v1/signals/webhook/:webhookId',
    product: 'spot',

    summary: "A chart alert for one of your webhooks; the webhook's own token in the body, never an API key",
  },
  // Derivatives
  {
    name: 'fetchFundingRate',
    method: 'GET',
    path: '/api/v1/funding-rate/:symbol',
    product: 'derivatives',

    summary: 'Published funding rate of one futures market',
    refusals: [{ status: '501', codes: ['trade.funding_rate_spot_market', 'trade.funding_rate_unavailable'] }],
  },
  {
    name: 'fetchFuturesOrderTypes',
    method: 'GET',
    path: '/api/v1/futures/order-types',
    product: 'derivatives',

    summary: 'Order types, time in force and flags per futures market',
  },
  {
    name: 'fetchFuturesMarginModes',
    method: 'GET',
    path: '/api/v1/futures/margin-modes',
    product: 'derivatives',

    summary: 'Futures margin modes, whether each is offered, and the typed refusal of each that is not',
  },
  {
    name: 'fetchFundingRateHistory',
    method: 'GET',
    path: '/api/v1/funding-history/:symbol',
    product: 'derivatives',

    summary: 'Funding rate history of one futures market',
  },
  {
    name: 'fetchFuturesTicker',
    method: 'GET',
    path: '/api/v1/futures/ticker',
    product: 'derivatives',

    summary: 'The futures strip; a market fact not yet known is null',
  },
  {
    name: 'fetchLeverageTiers',
    method: 'GET',
    path: '/api/v1/futures/tiers',
    product: 'derivatives',

    summary: 'The leverage and margin tiers per futures market, as published',
  },
  {
    name: 'fetchOutcomeMarkets',
    method: 'GET',
    path: '/api/v1/outcomes/markets',
    product: 'derivatives',

    summary: 'Listed outcome markets',
  },
  {
    name: 'fetchPositions',
    method: 'GET',
    path: '/api/v1/positions',
    product: 'derivatives',

    summary: 'Open positions',
  },
  {
    name: 'fetchClosedPositions',
    method: 'GET',
    path: '/api/v1/positions/closed',
    product: 'derivatives',

    summary: 'Closed and liquidated positions',
  },
  {
    name: 'fetchPosition',
    method: 'GET',
    path: '/api/v1/positions/:id',
    product: 'derivatives',

    summary: 'One position',
  },
  {
    name: 'fetchPositionMarginCall',
    method: 'GET',
    path: '/api/v1/positions/:id/margin-call',
    product: 'derivatives',

    summary: 'The margin call open on one position',
  },
  {
    name: 'openPosition',
    method: 'POST',
    path: '/api/v1/positions',
    product: 'derivatives',

    summary: 'Open an isolated futures position at the mark, with the leverage named',
  },
  {
    name: 'closePositionQuantity',
    method: 'POST',
    path: '/api/v1/positions/:id/close',
    product: 'derivatives',

    summary: 'Close a position, in full or in part',
  },
  {
    name: 'closePosition',
    method: 'DELETE',
    path: '/api/v1/positions/:id',
    product: 'derivatives',

    summary: 'Mounted to refuse a cancel-shaped close; a position closes through its close route',
  },
  {
    name: 'addIsolatedMargin',
    method: 'POST',
    path: '/api/v1/positions/margin',
    product: 'derivatives',

    summary: 'Add collateral to an isolated position',
  },
  {
    name: 'reduceIsolatedMargin',
    method: 'POST',
    path: '/api/v1/positions/margin/reduce',
    product: 'derivatives',

    summary: 'Take excess collateral out of an isolated position',
  },
  {
    name: 'fetchAdlDisclosure',
    method: 'GET',
    path: '/api/v1/futures/adl-disclosure',
    product: 'derivatives',

    summary: 'The auto-deleveraging disclosure, and whether this account has acknowledged it',
  },
  {
    name: 'ackAdlDisclosure',
    method: 'POST',
    path: '/api/v1/futures/adl-disclosure/ack',
    product: 'derivatives',

    summary: 'Acknowledge the current auto-deleveraging disclosure',
  },
  {
    name: 'fetchAdlDisclosureEvents',
    method: 'GET',
    path: '/api/v1/futures/adl-events',
    product: 'derivatives',

    summary: 'Auto-deleveraging events disclosed to this account',
  },
  {
    name: 'setLeverage',
    method: 'POST',
    path: '/api/v1/positions/leverage',
    product: 'derivatives',

    summary: 'Change the leverage of an isolated position',
    refusals: [{ status: '400', codes: ['trade.leverage_too_high', 'trade.leverage_would_liquidate', 'trade.insufficient_margin'] }],
  },
  {
    name: 'setMarginMode',
    method: 'POST',
    path: '/api/v1/positions/margin-mode',
    product: 'derivatives',

    summary: 'Mounted only to refuse: margin mode is chosen when a position opens',
    refusals: [{ status: '501', codes: ['trade.margin_mode_unsupported'] }],
  },
  {
    name: 'fetchGatedList',
    method: 'GET',
    path: '/api/v1/account/gated-list',
    product: 'derivatives',

    summary: 'Each futures contract open or blocked for this account, with every reason',
  },
  {
    name: 'fetchPositionLiquidation',
    method: 'GET',
    path: '/api/v1/positions/:id/liquidation',
    product: 'derivatives',

    summary: 'The liquidation state of one position',
  },
  {
    name: 'fetchLiquidations',
    method: 'GET',
    path: '/api/v1/futures/liquidations',
    product: 'derivatives',

    summary: 'This account’s liquidation rungs',
  },
  {
    name: 'fetchFuturesPayouts',
    method: 'GET',
    path: '/api/v1/futures/payouts',
    product: 'derivatives',

    summary: 'This account’s profit payouts: paid, or owed while the clearing pot is short',
  },
  {
    name: 'fetchFundingPayments',
    method: 'GET',
    path: '/api/v1/positions/:id/funding-payments',
    product: 'derivatives',

    summary: 'Funding paid and received on one position',
  },
  {
    name: 'closeAllPositions',
    method: 'POST',
    path: '/api/v1/futures/positions/close-all',
    product: 'derivatives',

    summary: 'Close every open position, or those in one market; clientBatchId is required',
  },
  {
    name: 'fetchMarginSummary',
    method: 'GET',
    path: '/api/v1/futures/margin-summary',
    product: 'derivatives',

    summary: 'This account’s futures margin in one summary',
  },
  {
    name: 'fetchPositionMode',
    method: 'GET',
    path: '/api/v1/futures/position-mode',
    product: 'derivatives',

    summary: 'This account’s position mode',
  },
  {
    name: 'setPositionMode',
    method: 'PUT',
    path: '/api/v1/futures/position-mode',
    product: 'derivatives',

    summary: 'Change this account’s position mode',
  },
  {
    name: 'setFuturesLeverage',
    method: 'POST',
    path: '/api/v1/futures/leverage',
    product: 'derivatives',

    summary: 'The same leverage change as POST /api/v1/positions/leverage',
    refusals: [{ status: '400', codes: ['trade.leverage_too_high', 'trade.leverage_would_liquidate', 'trade.insufficient_margin'] }],
  },
  {
    name: 'calculateFuturesRisk',
    method: 'POST',
    path: '/api/v1/futures/calculator',
    product: 'derivatives',

    summary: 'Margin, liquidation price and tier for a position you describe; nothing is placed',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'fetchCollateral',
    method: 'GET',
    path: '/api/v1/futures/collateral',
    product: 'derivatives',

    summary: 'Collateral by class, the buying power it leaves, and the classes refused with their code',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'createConditionalOrder',
    method: 'POST',
    path: '/api/v1/futures/conditional-orders',
    product: 'derivatives',

    summary: 'Place a conditional order that arms on its trigger',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'fetchConditionalOrders',
    method: 'GET',
    path: '/api/v1/futures/conditional-orders',
    product: 'derivatives',

    summary: 'This account’s conditional orders',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'fetchConditionalOrder',
    method: 'GET',
    path: '/api/v1/futures/conditional-orders/:id',
    product: 'derivatives',

    summary: 'One conditional order',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'cancelConditionalOrder',
    method: 'DELETE',
    path: '/api/v1/futures/conditional-orders/:id',
    product: 'derivatives',

    summary: 'Cancel one conditional order',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'setPositionProtection',
    method: 'PUT',
    path: '/api/v1/positions/:id/protection',
    product: 'derivatives',

    summary: 'Set the protective orders of one position',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'fetchPositionRiskStop',
    method: 'GET',
    path: '/api/v1/positions/:id/risk-stop',
    product: 'derivatives',

    summary: 'The pre-liquidation stop on one position, its close price and the margin ratio now',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'setPositionRiskStop',
    method: 'PUT',
    path: '/api/v1/positions/:id/risk-stop',
    product: 'derivatives',

    summary: 'Set or clear the pre-liquidation stop of one position',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'fetchEntryProtection',
    method: 'GET',
    path: '/api/v1/futures/entry-protection',
    product: 'derivatives',

    summary: 'What each opening order asked to be protected with, and how far its legs have armed',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'createFuturesOrder',
    method: 'POST',
    path: '/api/v1/futures/orders',
    product: 'derivatives',

    summary: 'Place a futures order in the book',
    signedOutWithoutMatching: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'fetchFuturesOrders',
    method: 'GET',
    path: '/api/v1/futures/orders',
    product: 'derivatives',

    summary: 'This account’s futures orders',
    signedOutWithoutMatching: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'fetchFuturesOrder',
    method: 'GET',
    path: '/api/v1/futures/orders/:id',
    product: 'derivatives',

    summary: 'One futures order: where it came from, its label, what its hold did',
    onlyWithFuturesMatching: true,
  },
  {
    name: 'fetchFuturesExecutions',
    method: 'GET',
    path: '/api/v1/futures/executions',
    product: 'derivatives',

    summary: 'This account’s futures executions: fills, liquidations and auto-deleverages',
    onlyWithFuturesMatching: true,
  },
  {
    name: 'cancelFuturesOrder',
    method: 'DELETE',
    path: '/api/v1/futures/orders/:id',
    product: 'derivatives',

    summary: 'Cancel one futures order',
    signedOutWithoutMatching: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'createSplitFuturesOrder',
    method: 'POST',
    path: '/api/v1/futures/orders/split',
    product: 'derivatives',

    summary: 'Place one futures order as several children; the answer lists each child placed',
    onlyWithFuturesMatching: true,
  },
  {
    name: 'reversePosition',
    method: 'POST',
    path: '/api/v1/positions/:id/reverse',
    product: 'derivatives',

    summary: 'Close a position and open the opposite one; the same request id never places a leg twice',
    onlyWithFuturesMatching: true,
  },
  {
    name: 'previewPosition',
    method: 'POST',
    path: '/api/v1/positions/preview',
    product: 'derivatives',

    summary: 'The risk of a futures position before it opens; nothing is placed',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'previewGreeksWhatIf',
    method: 'POST',
    path: '/api/v1/greeks/what-if',
    product: 'derivatives',

    summary: 'Option greeks under a what-if; nothing is placed',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'previewDeltaHedge',
    method: 'POST',
    path: '/api/v1/greeks/delta-hedge',
    product: 'derivatives',

    summary: 'The orders a delta hedge would place; none is placed',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'createOutcomeOrder',
    method: 'POST',
    path: '/api/v1/outcomes/orders',
    product: 'derivatives',

    summary: 'Place an order on an outcome market',
    signedOut: TRADE_UNAUTHENTICATED,
  },
  {
    name: 'publishOutcomeMarket',
    method: 'POST',
    path: '/api/v1/outcomes/markets/publish',
    product: 'derivatives',

    summary:
      'Service to service only: publish an outcome market. Today it answers 412 owner.decision (the owner has not decided who determines a result) and publishes nothing',
    signedOut: SERVICE_CREDENTIALS_REQUIRED,
  },
  {
    name: 'settleOutcomeMarket',
    method: 'POST',
    path: '/api/v1/outcomes/settle',
    product: 'derivatives',

    summary: 'Service to service only: settle an outcome market. No key or session reaches it',
    signedOut: SERVICE_CREDENTIALS_REQUIRED,
  },
  // Your own venue account (signed by your wallet; off unless switched on)
  {
    name: 'venueStatus',
    method: 'GET',
    path: '/api/v1/venue/status',
    product: 'accounts',

    summary: 'Whether the venue your own wallet trades on is switched on here, which venue it is, and whether it is TEST',
  },
  {
    name: 'venueMarkets',
    method: 'GET',
    path: '/api/v1/venue/markets',
    product: 'accounts',

    summary: 'The venue’s markets for your account: order types, time in force, margin modes, lot and tick, its fees or "not known"',
  },
  {
    name: 'venueGatedList',
    method: 'GET',
    path: '/api/v1/venue/gated-list',
    product: 'accounts',

    summary: 'Each perpetual on the venue, open or blocked for your account, with every reason a new open would be refused',
  },
  {
    name: 'venueBestPrices',
    method: 'GET',
    path: '/api/v1/venue/best-prices',
    product: 'accounts',

    summary:
      'The venue’s best bid and ask on one market, from its own book, with its as-of time: where a market order’s worst price is set from',
  },
  {
    name: 'venueBook',
    method: 'GET',
    path: '/api/v1/venue/book',
    product: 'accounts',

    summary: 'The venue’s own book on one market we list, bids and asks best first, each level’s price and size, with its as-of time',
  },
  {
    name: 'venueTrades',
    method: 'GET',
    path: '/api/v1/venue/trades',
    product: 'accounts',

    summary: 'The venue’s newest public prints on one market we list, newest first: price, size, the side that crossed and when',
  },
  {
    name: 'venueCandles',
    method: 'GET',
    path: '/api/v1/venue/candles',
    product: 'accounts',

    summary:
      'Candles of the venue’s own prints on one market we list, on one interval, oldest first: an interval with no print is not sent',
  },
  {
    name: 'venueFundingHistory',
    method: 'GET',
    path: '/api/v1/venue/funding-history',
    product: 'accounts',

    summary:
      'The funding the venue published at each settled interval on its listed perpetual on one asset, since a time: refused by name where none is published',
  },
  {
    name: 'venueBalances',
    method: 'GET',
    path: '/api/v1/venue/balances',
    product: 'accounts',

    summary: 'Your venue account’s balances (free and locked) as the venue reports them, with its as-of time',
  },
  {
    name: 'venueOpenOrders',
    method: 'GET',
    path: '/api/v1/venue/orders/open',
    product: 'accounts',

    summary: 'Your open orders on the venue, with what each one locks',
  },
  {
    name: 'venuePositions',
    method: 'GET',
    path: '/api/v1/venue/positions',
    product: 'accounts',

    summary: 'Your positions on the venue, with margin and liquidation price (or "not known")',
  },
  {
    name: 'venueAgents',
    method: 'GET',
    path: '/api/v1/venue/agents',
    product: 'accounts',

    summary: 'The agent keys your wallet has approved on the venue',
  },
  {
    name: 'venueSubAccounts',
    method: 'GET',
    path: '/api/v1/venue/sub-accounts',
    product: 'accounts',

    summary: 'Your sub-accounts on the venue, read on your main account',
  },
  {
    name: 'venueOrderByClientId',
    method: 'GET',
    path: '/api/v1/venue/orders/by-client-id',
    product: 'accounts',

    summary:
      'One venue order by your own client id (clientOrderKey) or the venue client order id: its state, and how an answer that was not definite is read back',
  },
  {
    name: 'venueOrderHistory',
    method: 'GET',
    path: '/api/v1/venue/orders/history',
    product: 'accounts',

    summary: 'Your venue order history as the venue keeps it, filtered by side, state, market and time placed, a page at a time',
  },
  {
    name: 'venueOrderRecord',
    method: 'GET',
    path: '/api/v1/venue/orders/record',
    product: 'accounts',

    summary: 'Our record of one venue order: when it was placed, each accepted amendment, and the builder fee it was signed with',
  },
  {
    name: 'venueFills',
    method: 'GET',
    path: '/api/v1/venue/fills',
    product: 'accounts',

    summary: 'Your fills on the venue since a time, with the venue’s fee and our builder fee as separate lines',
  },
  {
    name: 'venueDeposits',
    method: 'GET',
    path: '/api/v1/venue/deposits',
    product: 'accounts',

    summary: 'The on-chain deposits the venue has seen for your account: confirming, credited, or not credited and why',
  },
  {
    name: 'venueWithdrawalTerms',
    method: 'GET',
    path: '/api/v1/venue/withdrawal-terms',
    product: 'accounts',

    summary: "The venue's published terms for withdrawing an asset: its fee, the network fee and the arrival time, or not known",
  },
  {
    name: 'venueLeverage',
    method: 'GET',
    path: '/api/v1/venue/leverage',
    product: 'accounts',

    summary: 'Your leverage and margin mode on one venue perpetual, or none set',
  },
  {
    name: 'venueLeverageChange',
    method: 'GET',
    path: '/api/v1/venue/leverage-change',
    product: 'accounts',

    summary: "What a leverage change would do to your open position's margin, by the venue's own rule, before anything is signed",
  },
  {
    name: 'venueIsolatedMargin',
    method: 'GET',
    path: '/api/v1/venue/isolated-margin',
    product: 'accounts',

    summary: "Your open isolated position's margin on one venue perpetual and the venue's limit for removing it",
  },
  {
    name: 'venueAccountSummary',
    method: 'GET',
    path: '/api/v1/venue/account-summary',
    product: 'accounts',

    summary: 'Your equity, free collateral, used margin, maintenance and margin ratio as the venue reports them',
  },
  {
    name: 'venueLiquidation',
    method: 'GET',
    path: '/api/v1/venue/liquidation',
    product: 'accounts',

    summary: "Your position's liquidation state on one venue perpetual (none, in progress or done) and the venue's price and fee rules",
  },
  {
    name: 'venueLiquidations',
    method: 'GET',
    path: '/api/v1/venue/liquidations',
    product: 'accounts',

    summary: 'Each liquidation the venue reports on your account, every part with its price, size, fee and the venue’s ids',
  },
  {
    name: 'venueDeleverages',
    method: 'GET',
    path: '/api/v1/venue/deleverages',
    product: 'accounts',

    summary: 'Each auto-deleveraging of your positions the venue reports: the close and the venue’s notice',
  },
  {
    name: 'venueAdlDisclosure',
    method: 'GET',
    path: '/api/v1/venue/adl-disclosure',
    product: 'accounts',

    summary: 'The venue’s auto-deleveraging rules with their version, and whether you acknowledged that version',
  },
  {
    name: 'venueAdlDisclosureAck',
    method: 'POST',
    path: '/api/v1/venue/adl-disclosure/ack',
    product: 'accounts',

    summary: 'Acknowledge the version of the venue’s auto-deleveraging rules you read; a version it has replaced is refused',
  },
  {
    name: 'venueInsuranceFund',
    method: 'GET',
    path: '/api/v1/venue/insurance-fund',
    product: 'accounts',

    summary: 'The venue’s own insurance fund and where to read it, or “not published by this venue”, never 0',
  },
  {
    name: 'venueLiquidationAlerts',
    method: 'GET',
    path: '/api/v1/venue/liquidation-alerts',
    product: 'accounts',

    summary: 'The venue’s public liquidation and auto-deleveraging alerts: market, side, size and price, with no account',
  },
  {
    name: 'venueMarketMargin',
    method: 'GET',
    path: '/api/v1/venue/market-margin',
    product: 'accounts',

    summary: "Your balance in the margin account a market's deployer keeps for it, apart from your main account",
  },
  {
    name: 'venueSettlements',
    method: 'GET',
    path: '/api/v1/venue/settlements',
    product: 'accounts',

    summary: "Your positions the venue settled and orders it cancelled when a market's deployer halted it or it split",
  },
  {
    name: 'venueFundingPayments',
    method: 'GET',
    path: '/api/v1/venue/funding-payments',
    product: 'accounts',

    summary: 'The funding the venue charged or paid on each of your positions, one payment per position per period, as the venue booked it',
  },
  {
    name: 'venuePriceHistory',
    method: 'GET',
    path: '/api/v1/venue/price-history',
    product: 'accounts',

    summary:
      "The venue's mark or index price series on a listed perpetual, since a time: an index the venue does not publish answers null with its reason",
  },
  {
    name: 'venueScheduledCancel',
    method: 'GET',
    path: '/api/v1/venue/scheduled-cancel',
    product: 'accounts',

    summary: "When the venue's own scheduled cancel cancels every open order of your venue account, and when it last did",
  },
  {
    name: 'createVenueStatement',
    method: 'POST',
    path: '/api/v1/venue/statements',
    product: 'accounts',

    summary:
      "Ask for a statement of your venue account's orders, trades and money movements over a finished range, from the venue's own records",
  },
  {
    name: 'fetchVenueStatementFile',
    method: 'GET',
    path: '/api/v1/venue/statements/:id/file',
    product: 'accounts',

    summary: 'The file of one finished venue statement, with its SHA-256',
  },
  {
    name: 'venueBuilderFeeApproval',
    method: 'GET',
    path: '/api/v1/venue/builder-fee-approval',
    product: 'accounts',

    summary: 'The most your wallet has approved for our builder fee on the venue',
  },
  {
    name: 'venueFeeTier',
    method: 'GET',
    path: '/api/v1/venue/fee-tier',
    product: 'accounts',

    summary:
      'Your fee tier on the venue as it reports it: the tier, the volume it counted, your maker and taker rates, and when it last placed you',
  },
  {
    name: 'venueFees',
    method: 'GET',
    path: '/api/v1/venue/fees',
    product: 'accounts',

    summary:
      'The venue’s published fee tiers, each listed market’s maker and taker rates, the venue’s cap on a builder fee there, and our builder fee: blank reads not set',
  },
  {
    name: 'venueMarketVenues',
    method: 'GET',
    path: '/api/v1/venue/markets/:symbol/venues',
    product: 'accounts',

    summary: 'Every venue for one market: its price, depth and fees as it reports them, whether you can sign there, and whether it is up',
  },
  {
    name: 'venueRoutePreview',
    method: 'POST',
    path: '/api/v1/venue/route-preview',
    product: 'accounts',

    summary: 'Which venue your order goes to, its expected fill and fees, and why that venue',
  },
  {
    name: 'venueWithdrawal',
    method: 'GET',
    path: '/api/v1/venue/withdrawals/:nonce',
    product: 'accounts',

    summary: 'One venue withdrawal by its signed nonce: pending, done or failed, with its fee or "not known"',
  },
  {
    name: 'venuePreview',
    method: 'POST',
    path: '/api/v1/venue/preview',
    product: 'accounts',

    summary: 'What an order would lock and its fee lines, from the venue’s own figures. Sends nothing',
  },
  {
    name: 'venueConvertSellQuote',
    method: 'POST',
    path: '/api/v1/venue/convert/sell-quote',
    product: 'accounts',

    summary:
      'The venue’s own price for selling an amount on your venue account now: what fills, its average price and fees, or "not known". Sends nothing',
  },
  {
    name: 'venuePrepare',
    method: 'POST',
    path: '/api/v1/venue/prepare',
    product: 'accounts',

    summary:
      'The exact payload your wallet signs for an action, stored under its business key. Sends nothing; a withdrawal needs step-up first',
  },
  {
    name: 'venueSubmit',
    method: 'POST',
    path: '/api/v1/venue/submit',
    product: 'accounts',

    summary: 'Send the signed action. An answer that is not definite comes back with how to read it back; it is never sent as a new action',
  },
  {
    name: 'venueAgentAccountTerms',
    method: 'GET',
    path: '/api/v1/venue/agent-accounts/terms',
    product: 'accounts',

    summary:
      "The owner's ceiling for an agent account's cap, its funding asset and the bounds on every assistant order; a blank one refuses",
  },
  {
    name: 'venueAgentAccounts',
    method: 'GET',
    path: '/api/v1/venue/agent-accounts',
    product: 'accounts',

    summary:
      'Your agent accounts: each a sub-account under your wallet, with its cap, what you moved in and out, and its balances as the venue reports them',
  },
  {
    name: 'venueAgentAccountCreate',
    method: 'POST',
    path: '/api/v1/venue/agent-accounts',
    product: 'accounts',

    summary:
      'Create an agent account with a cap and its first funding, after step-up; your wallet signs opening the sub-account, the agent permission and the move',
  },
  {
    name: 'venueAgentAccount',
    method: 'GET',
    path: '/api/v1/venue/agent-accounts/:id',
    product: 'accounts',

    summary: 'One agent account, read back from the venue, with the next action your wallet is asked to sign',
  },
  {
    name: 'venueAgentAccountSubmit',
    method: 'POST',
    path: '/api/v1/venue/agent-accounts/:id/submit',
    product: 'accounts',

    summary: "Send one of the agent account's actions with your wallet's signature; each is sent once under its key",
  },
  {
    name: 'venueAgentAccountAbandon',
    method: 'POST',
    path: '/api/v1/venue/agent-accounts/:id/abandon',
    product: 'accounts',

    summary: 'End an agent account you rejected a signature for while it was opening, before its first move is signed; nothing moves',
  },
  {
    name: 'venueAgentAccountFund',
    method: 'POST',
    path: '/api/v1/venue/agent-accounts/:id/fund',
    product: 'accounts',

    summary: 'Move more into the agent account; past your cap it is refused, naming the room left, before your wallet is asked',
  },
  {
    name: 'venueAgentAccountWithdraw',
    method: 'POST',
    path: '/api/v1/venue/agent-accounts/:id/withdraw',
    product: 'accounts',

    summary: "Move the agent account's balance back to your main venue account",
  },
  {
    name: 'venueAgentAccountCap',
    method: 'POST',
    path: '/api/v1/venue/agent-accounts/:id/cap',
    product: 'accounts',

    summary: "Change the agent account's cap; above the owner's ceiling it is refused, naming the ceiling",
  },
  {
    name: 'venueAgentAccountLimits',
    method: 'POST',
    path: '/api/v1/venue/agent-accounts/:id/limits',
    product: 'accounts',

    summary: "Set the agent account's per-order size, leverage and daily-loss caps; one above the owner's ceiling is refused, naming it",
  },
  {
    name: 'venueAgentAccountClose',
    method: 'POST',
    path: '/api/v1/venue/agent-accounts/:id/close',
    product: 'accounts',

    summary: 'Close the agent account; refused, naming it, while a position, an order, a balance or a move is open',
  },
  {
    name: 'venueAgentConnections',
    method: 'GET',
    path: '/api/v1/venue/agent-accounts/connections',
    product: 'accounts',

    summary: 'Which of your agent API keys is connected to which agent account; a key trades only the account it is connected to',
  },
  {
    name: 'venueAgentConnect',
    method: 'POST',
    path: '/api/v1/venue/agent-accounts/:id/connections',
    product: 'accounts',

    summary:
      'Connect one of your agent API keys to this agent account, from your own sign-in after step-up, never from a key; a key already connected elsewhere is refused',
  },
  {
    name: 'venueAgentRevoke',
    method: 'POST',
    path: '/api/v1/venue/agent-accounts/connections/:keyId/revoke',
    product: 'accounts',

    summary:
      "Revoke your assistant, from your own sign-in: its key places nothing more, its resting orders are cancelled once, our copy of its venue agent key is dropped, and your wallet signs the venue's revoke; open positions stay",
  },
  {
    name: 'venueAgentActivity',
    method: 'GET',
    path: '/api/v1/venue/agent-accounts/connections/:keyId/activity',
    product: 'accounts',

    summary:
      "Your assistant connection's Activity, from your own sign-in: one row per call made with its key, refused ones included, newest first, each with its time, tool, outcome and order id; format=csv exports the same rows",
  },
  {
    name: 'venueAgentOrder',
    method: 'POST',
    path: '/api/v1/venue/agent/orders',
    product: 'accounts',

    summary:
      "Your assistant's spot order, from its agent key: placed only on the agent account the key is connected to, held to your cap first, and sent once per clientOrderId; an answer that is not definite is 202, retried with the same id",
  },
  {
    name: 'ownAgentAllowances',
    method: 'GET',
    path: '/api/v1/venue/own-agents/:agentId/allowances',
    product: 'accounts',

    summary:
      'Your own agent’s allowances on your venue sub-account: amount, what is left, period end and whether the venue still lists its agent permission',
  },
  {
    name: 'ownAgentAllowanceGrant',
    method: 'POST',
    path: '/api/v1/venue/own-agents/:agentId/allowances',
    product: 'accounts',

    summary:
      'Grant your own agent an allowance (amount and period) on one of your venue sub-accounts; a blank amount or period is refused with the field named, and the answer is the agent permission for your wallet to sign',
  },
  {
    name: 'ownAgentAllowanceSubmit',
    method: 'POST',
    path: '/api/v1/venue/own-agents/:agentId/allowances/:id/submit',
    product: 'accounts',

    summary: 'Send your wallet’s signature of the allowance’s agent permission, or of its revoke, to the venue',
  },
  {
    name: 'ownAgentAllowanceAbandon',
    method: 'POST',
    path: '/api/v1/venue/own-agents/:agentId/allowances/:id/abandon',
    product: 'accounts',

    summary: 'Your wallet rejected the agent permission: the allowance is not granted and nothing was sent',
  },
  {
    name: 'ownAgentAllowanceRevoke',
    method: 'POST',
    path: '/api/v1/venue/own-agents/:agentId/allowances/:id/revoke',
    product: 'accounts',

    summary:
      'Revoke the allowance: our copy of the agent key is dropped and the next order refused at once; the answer is the venue’s revoke for your wallet to sign',
  },
  {
    name: 'venueProtections',
    method: 'GET',
    path: '/api/v1/venue/protections',
    product: 'accounts',

    summary:
      'A position’s protections on your own venue account: the venue’s trigger orders and the stops our engine runs, each with where it rests, its trigger and source, and its state',
  },
  {
    name: 'venueProtectionCreate',
    method: 'POST',
    path: '/api/v1/venue/protections',
    product: 'accounts',

    summary:
      'Protect a position: a take profit, stop loss, stop market or stop limit the venue takes answers its unsigned trigger order for your wallet; a trailing stop or an index stop is armed on our engine (201) under your agent permission',
  },
  {
    name: 'venueProtectionCancel',
    method: 'DELETE',
    path: '/api/v1/venue/protections/:id',
    product: 'accounts',

    summary: 'Cancel a stop on our engine that has not fired; nothing is sent to the venue',
  },
  {
    name: 'venueProtectionAgent',
    method: 'GET',
    path: '/api/v1/venue/protection-agent',
    product: 'accounts',

    summary:
      'The agent key our engine signs your stops with, and whether your venue account lists it approved; it can trade, never withdraw',
  },
  {
    name: 'venueProtectionAgentPrepare',
    method: 'POST',
    path: '/api/v1/venue/protection-agent/prepare',
    product: 'accounts',

    summary: 'The unsigned approval of that agent key, for your wallet to sign and send through /api/v1/venue/submit',
  },
  {
    name: 'venueSpotOrders',
    method: 'GET',
    path: '/api/v1/venue/spot-orders',
    product: 'accounts',

    summary:
      'Your stop-limit, stop-market, OCO, bracket and linked-close orders on your own venue account: each leg with where it rests, its trigger, what the venue locks for it now and its state',
  },
  {
    name: 'venueSpotOrderCreate',
    method: 'POST',
    path: '/api/v1/venue/spot-orders',
    product: 'accounts',

    summary:
      'Place a conditional spot order: a stop the venue holds answers its unsigned trigger order for your wallet; the rest is run by INTAFACED on our engine (201) under your agent permission, a bracket’s entry answered unsigned for your wallet',
  },
  {
    name: 'venueSpotOrderReview',
    method: 'POST',
    path: '/api/v1/venue/spot-orders/review',
    product: 'accounts',

    summary: 'The fee of each leg of a conditional spot order, as maker or taker, from the venue’s published schedule and our builder fee',
  },
  {
    name: 'venueSpotOrderModify',
    method: 'PATCH',
    path: '/api/v1/venue/spot-orders/:id',
    product: 'accounts',

    summary: 'Change a live stop’s trigger and limit, judged as a new one would be',
  },
  {
    name: 'venueSpotOrderCancel',
    method: 'DELETE',
    path: '/api/v1/venue/spot-orders/:id',
    product: 'accounts',

    summary: 'Cancel a conditional spot order: what rests on the venue for it is cancelled there, releasing its lock',
  },
  {
    name: 'venueSpotAgent',
    method: 'GET',
    path: '/api/v1/venue/spot-agent',
    product: 'accounts',

    summary:
      'The agent key our engine signs your conditional spot orders with, and whether your venue account lists it approved; it can trade, never withdraw',
  },
  {
    name: 'venueSpotAgentPrepare',
    method: 'POST',
    path: '/api/v1/venue/spot-agent/prepare',
    product: 'accounts',

    summary: 'The unsigned approval of the spot-order agent key, for your wallet to sign and send through /api/v1/venue/submit',
  },
  {
    name: 'liveRuns',
    method: 'GET',
    path: '/api/v1/quant/live-runs',
    product: 'accounts',

    summary: 'Your live strategy runs, newest first: strategy, version, state and why a run stopped',
  },
  {
    name: 'liveRunStart',
    method: 'POST',
    path: '/api/v1/quant/live-runs',
    product: 'accounts',

    summary:
      'Start a saved order-block strategy live on one of your own venue sub-accounts, from a signed-in session only (an API key answers 404 quant.key_no_such_endpoint: there is no deploy by key); a blank restart-attempt, state-on-restart or cap setting is refused with the field named, and the answer is the agent permission for your wallet to sign',
  },
  {
    name: 'liveRun',
    method: 'GET',
    path: '/api/v1/quant/live-runs/:id',
    product: 'accounts',

    summary:
      'One live run: state, safeguards (restarts, state kept or dropped), its orders read back by client order id, your sub-account as the venue reports it with its as-of time, and the log',
  },
  {
    name: 'liveRunSubmit',
    method: 'POST',
    path: '/api/v1/quant/live-runs/:id/submit',
    product: 'accounts',

    summary: 'Send your wallet’s signature of the run’s agent permission to the venue; the run goes live once the venue lists it',
  },
  {
    name: 'liveRunStop',
    method: 'POST',
    path: '/api/v1/quant/live-runs/:id/stop',
    product: 'accounts',

    summary: 'Stop the run: its open venue orders are cancelled and the position is kept; the same seq again changes nothing',
  },
  {
    name: 'liveRunLiquidate',
    method: 'POST',
    path: '/api/v1/quant/live-runs/:id/liquidate',
    product: 'accounts',

    summary:
      'Liquidate the run: stop it, then one reduce-only order per position under algo:liquidate:<run>:<seq>; the run ends flat; refused with the freeze reason while your account is frozen',
  },
  {
    name: 'liveRunOrder',
    method: 'POST',
    path: '/api/v1/quant/live-runs/:id/orders',
    product: 'accounts',

    summary:
      'A manual order for a running strategy under its next seq; the same seq again is the same order; refused without the live-control grant',
  },
  {
    name: 'liveRunTestKill',
    method: 'POST',
    path: '/api/v1/quant/live-runs/:id/test/kill-process',
    product: 'accounts',

    summary: 'TEST venue only: stop the run’s process heartbeat, so the supervisor reconciles and restarts it within its attempt limit',
  },
  {
    name: 'ownAgentOrderPreview',
    method: 'POST',
    path: '/api/v1/venue/own-agents/:agentId/orders/preview',
    product: 'accounts',

    summary:
      'Preview your own agent’s order: side, market, order type, size, price, fee and what it draws on the allowance; nothing is sent',
  },
  {
    name: 'ownAgentOrder',
    method: 'POST',
    path: '/api/v1/venue/own-agents/:agentId/orders',
    product: 'accounts',

    summary:
      'Place the order you approved: held to the allowance and your agent policy before the agent permission signs, and sent once per orderId; an answer that is not definite is 202, retried with the same id',
  },
  {
    name: 'ownAgentOrders',
    method: 'GET',
    path: '/api/v1/venue/own-agents/:agentId/orders',
    product: 'accounts',

    summary: 'Your own agent’s orders, each read back from the venue by its client order id',
  },
  {
    name: 'ownAgentRebalances',
    method: 'GET',
    path: '/api/v1/venue/own-agents/:agentId/rebalances',
    product: 'accounts',

    summary:
      'The Portfolio planner’s rebalance proposals for your own agent’s sub-account, newest first: holdings as the venue reports them, each order, and whether you approved or rejected it',
  },
  {
    name: 'ownAgentRebalancePropose',
    method: 'POST',
    path: '/api/v1/venue/own-agents/:agentId/rebalances',
    product: 'accounts',

    summary:
      'Ask the Portfolio planner for a rebalance to your targets (proposalId and each asset’s percent): the market orders it proposes, and nothing is sent; a blank target is refused naming the asset',
  },
  {
    name: 'ownAgentRebalanceApprove',
    method: 'POST',
    path: '/api/v1/venue/own-agents/:agentId/rebalances/:id/approve',
    product: 'accounts',

    summary:
      'Approve a proposal: refused whole when its orders need more than the allowance has left; otherwise each order is placed by the agent permission, once, and approving again reads the same orders back',
  },
  {
    name: 'ownAgentRebalanceReject',
    method: 'POST',
    path: '/api/v1/venue/own-agents/:agentId/rebalances/:id/reject',
    product: 'accounts',

    summary: 'Reject a proposal: nothing is sent, nothing changes, and it is never approved',
  },
  {
    name: 'venueOrders',
    method: 'GET',
    path: '/api/v1/venue/orders',
    product: 'accounts',

    summary: 'Your orders sent through the venue door, oldest first, a page at a time by cursor; each order once',
  },
  {
    name: 'venueOrderByKey',
    method: 'GET',
    path: '/api/v1/venue/orders/by-key',
    product: 'accounts',

    summary: 'One order by its Idempotency-Key or action key: accepted with the venue’s record, or unknown until the venue answers',
  },
  {
    name: 'venueSession',
    method: 'GET',
    path: '/api/v1/venue/session',
    product: 'accounts',

    summary: 'This sign-in’s trading session: its key’s address and expiry, read against the venue’s own agent list',
  },
  {
    name: 'venueSessionStart',
    method: 'POST',
    path: '/api/v1/venue/session/start',
    product: 'accounts',

    summary:
      'Your wallet’s one approval for a fresh session key that can trade and never withdraw. Takes the key’s address only; signed-in session only',
  },
  {
    name: 'venueSessionEnd',
    method: 'POST',
    path: '/api/v1/venue/session/end',
    product: 'accounts',

    summary: 'Your wallet’s revoke of this sign-in’s session key. A key once used is never approved again',
  },
  // Accounts
  {
    name: 'fetchBalance',
    method: 'GET',
    path: '/api/v1/account/balance',
    product: 'accounts',

    summary: 'Account balances',
  },
  {
    name: 'fetchTradingFees',
    method: 'GET',
    path: '/api/v1/account/fees',
    product: 'accounts',

    summary: 'Maker and taker fee rates',
  },
  {
    name: 'fetchMyTrades',
    method: 'GET',
    path: '/api/v1/account/trades',
    product: 'accounts',

    summary: 'The account’s own fills',
  },
  {
    name: 'fetchLedger',
    method: 'GET',
    path: '/api/v1/ledger',
    product: 'accounts',

    summary: 'The account’s balance changes, newest first',
  },
  {
    name: 'createStatementExport',
    method: 'POST',
    path: '/api/v1/statements',
    product: 'accounts',

    summary: 'Ask for a statement of orders, trades and balance changes over a finished range',
  },
  {
    name: 'fetchStatementExport',
    method: 'GET',
    path: '/api/v1/statements/:id',
    product: 'accounts',

    summary: 'One statement request and its state',
  },
  {
    name: 'fetchStatementExportFile',
    method: 'GET',
    path: '/api/v1/statements/:id/file',
    product: 'accounts',

    summary: 'A finished statement as a CSV file',
  },
  {
    name: 'fetchFeeTier',
    method: 'GET',
    path: '/api/v1/account/fee-tier',
    product: 'accounts',

    summary: 'This account’s fee tier',
    signedOut: TRADE_UNAUTHENTICATED_CODE,
  },
  {
    name: 'fetchAccountMarketLifecycle',
    method: 'GET',
    path: '/api/v1/account/market-lifecycle/:symbol',
    product: 'accounts',

    summary: 'The listing state of one market as this account meets it',
  },
  {
    name: 'requestApiKeyRotation',
    method: 'POST',
    path: '/api/v1/account/api-key/rotation',
    product: 'accounts',

    summary: 'The calling key asks for its own rotation; a different person on the account approves it',
  },
  {
    name: 'approveApiKeyRotation',
    method: 'POST',
    path: '/api/v1/account/api-key/rotation/approve',
    product: 'accounts',

    summary: 'Approve a rotation request. A key never approves its own: refused identity.rotation_self_approval',
  },
  {
    name: 'fetchConvertExport',
    method: 'GET',
    path: '/api/v1/convert/export',
    product: 'accounts',

    summary: 'This account’s convert history as a CSV file',
  },
  {
    name: 'fetchCopyExport',
    method: 'GET',
    path: '/api/v1/copy/export',
    product: 'accounts',

    summary: 'This account’s copy-trading history as a CSV file',
  },
  {
    name: 'createLeadOrder',
    method: 'POST',
    path: '/api/v1/copy/lead/orders',
    product: 'accounts',
    summary: 'Place an order as an approved copy-trading lead, on an instrument your lead listing names; then as Place an order',
  },
  {
    name: 'fetchRfqExport',
    method: 'GET',
    path: '/api/v1/rfq/export',
    product: 'accounts',

    summary: 'This account’s request-for-quote history as a CSV file',
  },
  {
    name: 'fetchGridBots',
    method: 'GET',
    path: '/api/v1/bots/grid',
    product: 'spot',

    summary: 'This account’s spot grid bots',
  },
  {
    name: 'fetchGridBot',
    method: 'GET',
    path: '/api/v1/bots/grid/:id',
    product: 'spot',

    summary: 'One spot grid bot, with its levels and orders',
  },
  {
    name: 'createGridBot',
    method: 'POST',
    path: '/api/v1/bots/grid',
    product: 'spot',

    summary: 'Start a neutral spot grid bot; the same clientId returns the same bot',
  },
  {
    name: 'stopGridBot',
    method: 'POST',
    path: '/api/v1/bots/grid/:id/stop',
    product: 'spot',

    summary: 'Stop a grid bot; what it bought stays in the balance (settlement keep)',
  },
  {
    name: 'withdrawGridProfit',
    method: 'POST',
    path: '/api/v1/bots/grid/:id/withdraw',
    product: 'spot',

    summary:
      'Refused for every key (403 trade.api_withdraw_not_allowed): no API key or bot can withdraw; you withdraw from the venue with your own wallet, and nothing moves',
  },
  {
    name: 'fetchAlgoOrders',
    method: 'GET',
    path: '/api/v1/algo',
    product: 'spot',

    summary: 'Your algo orders (TWAP, VWAP, POV, chase), newest first; limit is required',
  },
  {
    name: 'fetchAlgoOrder',
    method: 'GET',
    path: '/api/v1/algo/:id',
    product: 'spot',

    summary: 'One algo order with its filled quantity',
  },
  {
    name: 'createAlgoOrder',
    method: 'POST',
    path: '/api/v1/algo',
    product: 'spot',

    summary:
      'Place a twap, vwap, pov or chase order (kind in the body); the same clientAlgoId returns the same order; trigger, oco, conditional and trailing refuse trade.algo_kind_not_built',
  },
  {
    name: 'editAlgoOrder',
    method: 'PATCH',
    path: '/api/v1/algo/:id',
    product: 'spot',

    summary: 'Refused trade.algo_params_immutable: an algo order’s parameters are fixed at create',
  },
  {
    name: 'cancelAlgoOrder',
    method: 'POST',
    path: '/api/v1/algo/:id/cancel',
    product: 'spot',

    summary: 'Cancel an algo order; no new slices are placed',
  },
  {
    name: 'fetchVipApplications',
    method: 'GET',
    path: '/api/v1/vip/applications',
    product: 'accounts',

    summary: 'This account’s VIP applications',
    signedOut: TRADE_UNAUTHENTICATED_CODE,
  },
  {
    name: 'applyForVip',
    method: 'POST',
    path: '/api/v1/vip/applications',
    product: 'accounts',

    summary: 'Apply for a VIP tier',
    signedOut: TRADE_UNAUTHENTICATED_CODE,
  },
  {
    name: 'fetchAdminOpenOrders',
    method: 'GET',
    path: '/api/v1/admin/orders/open',
    product: 'accounts',

    summary: 'Staff only: open orders across accounts',
  },
  {
    name: 'fetchAdminFees',
    method: 'GET',
    path: '/api/v1/admin/fees',
    product: 'accounts',

    summary: 'Staff only: the fee schedule customers are charged, per market, with its source',
  },
];

export const REST_REFERENCE: readonly RestRoute[] = ROUTE_WORDS.flatMap((words) => {
  const served = SERVED.get(`${words.method} ${words.path}`);
  return served ? [{ ...words, ...served }] : [];
});

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
  return (['trade:read', 'trade:write', 'copy:lead'] as const).map((scope) => ({
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
