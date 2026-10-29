/**
 * The trading API as the developer pages publish it: every route and stream, its product, the permission a key needs,
 * what one call costs and the refusals every caller can meet. Nothing here is invented. It mirrors, and
 * `developers-reference.test.ts` checks it against, these sources:
 *
 * - the contract route table and channel table, `REST_ROUTES` and `WS_CHANNELS` in `packages/exchange-contract/src/api.ts`
 *   (the browser build cannot import that package's root, so the rows are copied and the test fails when they drift);
 * - every public route svc-trade mounts, `services/svc-trade/src/public-rest.ts`, and the private routes it mounts in
 *   `services/svc-trade/src/private-rest.ts`;
 * - the key plane in svc-edge: `requiredScopeFor` in `services/svc-edge/src/gateway-plane.ts` (a key needs `trade:read`
 *   for a read and `trade:write` for anything else on `/api/v1`), and `EDGE_RATE_COST` in `services/svc-edge/src/hardening.ts`
 *   (every counted request costs 1; there are no per-route weights).
 *
 * - svc-trade's live inventory, `CCXT_CAPABILITY_MATRIX` in `services/svc-trade/src/ccxt-capability-matrix.ts`, served at
 *   `GET /api/v1/capabilities`: every route in it is here, the position, order and statement doors beyond the contract
 *   table included. Where the inventory names a read scope on a POST, the edge's rule above is what a key meets.
 */

export type Product = 'general' | 'spot' | 'derivatives' | 'funding' | 'accounts';
export const PRODUCTS: readonly Product[] = ['general', 'spot', 'derivatives', 'funding', 'accounts'];

export type Method = 'GET' | 'POST' | 'DELETE';
export type Scope = 'trade:read' | 'trade:write';

export type RestRoute = {
  /** The CCXT-style method name; the contract table's key where the route is in it. */
  name: string;
  method: Method;
  path: string;
  product: Product;
  /** True when svc-trade answers without any credential (`public-rest.ts`). */
  anonymous: boolean;
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
export const scopeFor = (method: Method): Scope => (method === 'GET' ? 'trade:read' : 'trade:write');

export const REST_REFERENCE: readonly RestRoute[] = [
  // General
  {
    name: 'fetchTime',
    method: 'GET',
    path: '/api/v1/time',
    product: 'general',
    anonymous: true,
    summary: 'Server time in Unix milliseconds',
  },
  {
    name: 'fetchCapabilities',
    method: 'GET',
    path: '/api/v1/capabilities',
    product: 'general',
    anonymous: true,
    summary: 'The live inventory of routes, their refusals and the rate limit notes',
  },
  // Spot: public
  { name: 'fetchMarkets', method: 'GET', path: '/api/v1/markets', product: 'spot', anonymous: true, summary: 'Listed markets' },
  {
    name: 'fetchTicker',
    method: 'GET',
    path: '/api/v1/ticker/:symbol',
    product: 'spot',
    anonymous: true,
    summary: 'Best bid, ask and last trade of one market',
  },
  {
    name: 'fetchTickers',
    method: 'GET',
    path: '/api/v1/tickers',
    product: 'spot',
    anonymous: true,
    summary: 'Tickers of every market with a book',
  },
  {
    name: 'fetchOrderBook',
    method: 'GET',
    path: '/api/v1/orderbook/:symbol',
    product: 'spot',
    anonymous: true,
    summary: 'Order book depth of one market',
  },
  {
    name: 'fetchOHLCV',
    method: 'GET',
    path: '/api/v1/ohlcv/:symbol',
    product: 'spot',
    anonymous: true,
    summary: 'Candles built from real fills',
  },
  {
    name: 'fetchTrades',
    method: 'GET',
    path: '/api/v1/trades/:symbol',
    product: 'spot',
    anonymous: true,
    summary: 'Public trade tape of one market',
  },
  {
    name: 'fetchMarketHalt',
    method: 'GET',
    path: '/api/v1/market-halt/:symbol',
    product: 'spot',
    anonymous: true,
    summary: 'Whether one market is halted',
  },
  {
    name: 'fetchMarketLifecycle',
    method: 'GET',
    path: '/api/v1/market-lifecycle/:symbol',
    product: 'spot',
    anonymous: true,
    summary: 'Listing state of one market',
  },
  {
    name: 'fetchChartOwnerValues',
    method: 'GET',
    path: '/api/v1/charts/owner-values',
    product: 'spot',
    anonymous: true,
    summary: 'Chart limits the owner has set; a blank one is null',
  },
  // Spot: private
  { name: 'createOrder', method: 'POST', path: '/api/v1/orders', product: 'spot', anonymous: false, summary: 'Place an order' },
  {
    name: 'cancelOrder',
    method: 'DELETE',
    path: '/api/v1/orders/:id',
    product: 'spot',
    anonymous: false,
    summary: 'Cancel one open order',
  },
  { name: 'cancelAllOrders', method: 'DELETE', path: '/api/v1/orders', product: 'spot', anonymous: false, summary: 'Cancel open orders' },
  { name: 'fetchOrder', method: 'GET', path: '/api/v1/orders/:id', product: 'spot', anonymous: false, summary: 'One order' },
  { name: 'fetchOpenOrders', method: 'GET', path: '/api/v1/orders/open', product: 'spot', anonymous: false, summary: 'Open orders' },
  { name: 'fetchClosedOrders', method: 'GET', path: '/api/v1/orders/closed', product: 'spot', anonymous: false, summary: 'Closed orders' },
  {
    name: 'previewOrder',
    method: 'POST',
    path: '/api/v1/orders/preview',
    product: 'spot',
    anonymous: false,
    summary: 'What an order would hold and cost, and why it would be refused, without placing it',
  },
  {
    name: 'batchAmendOrders',
    method: 'POST',
    path: '/api/v1/orders/batch-amend',
    product: 'spot',
    anonymous: false,
    summary: 'Amend several open orders one by one, with a result for each',
  },
  {
    name: 'batchCancelOrders',
    method: 'POST',
    path: '/api/v1/orders/batch-cancel',
    product: 'spot',
    anonymous: false,
    summary: 'Cancel several orders by id one by one, with a result for each',
  },
  {
    name: 'massCancelOrders',
    method: 'POST',
    path: '/api/v1/markets/:marketId/orders/mass-cancel',
    product: 'spot',
    anonymous: false,
    summary: 'Cancel the caller’s open orders in one market',
  },
  {
    name: 'cancelAllOrdersAfter',
    method: 'POST',
    path: '/api/v1/orders/cancel-all-after',
    product: 'spot',
    anonymous: false,
    summary: 'Arm or disarm the switch that cancels every open order after a timeout',
  },
  {
    name: 'fetchCancelAllAfter',
    method: 'GET',
    path: '/api/v1/orders/cancel-all-after',
    product: 'spot',
    anonymous: false,
    summary: 'Whether the cancel-all switch is armed, and the timeouts allowed',
  },
  // Derivatives
  {
    name: 'fetchFundingRate',
    method: 'GET',
    path: '/api/v1/funding-rate/:symbol',
    product: 'derivatives',
    anonymous: true,
    summary: 'Published funding rate of one futures market',
    refusals: [{ status: '501', codes: ['trade.funding_rate_spot_market', 'trade.funding_rate_unavailable'] }],
  },
  {
    name: 'fetchFuturesOrderTypes',
    method: 'GET',
    path: '/api/v1/futures/order-types',
    product: 'derivatives',
    anonymous: true,
    summary: 'Order types, time in force and flags per futures market',
  },
  { name: 'fetchPositions', method: 'GET', path: '/api/v1/positions', product: 'derivatives', anonymous: false, summary: 'Open positions' },
  {
    name: 'fetchClosedPositions',
    method: 'GET',
    path: '/api/v1/positions/closed',
    product: 'derivatives',
    anonymous: false,
    summary: 'Closed and liquidated positions',
  },
  {
    name: 'fetchPosition',
    method: 'GET',
    path: '/api/v1/positions/:id',
    product: 'derivatives',
    anonymous: false,
    summary: 'One position',
  },
  {
    name: 'fetchPositionMarginCall',
    method: 'GET',
    path: '/api/v1/positions/:id/margin-call',
    product: 'derivatives',
    anonymous: false,
    summary: 'The margin call open on one position',
  },
  {
    name: 'openPosition',
    method: 'POST',
    path: '/api/v1/positions',
    product: 'derivatives',
    anonymous: false,
    summary: 'Open an isolated futures position at the mark, with the leverage named',
  },
  {
    name: 'closePositionQuantity',
    method: 'POST',
    path: '/api/v1/positions/:id/close',
    product: 'derivatives',
    anonymous: false,
    summary: 'Close a position, in full or in part',
  },
  {
    name: 'closePosition',
    method: 'DELETE',
    path: '/api/v1/positions/:id',
    product: 'derivatives',
    anonymous: false,
    summary: 'Mounted to refuse a cancel-shaped close; a position closes through its close route',
  },
  {
    name: 'addIsolatedMargin',
    method: 'POST',
    path: '/api/v1/positions/margin',
    product: 'derivatives',
    anonymous: false,
    summary: 'Add collateral to an isolated position',
  },
  {
    name: 'reduceIsolatedMargin',
    method: 'POST',
    path: '/api/v1/positions/margin/reduce',
    product: 'derivatives',
    anonymous: false,
    summary: 'Take excess collateral out of an isolated position',
  },
  {
    name: 'fetchAdlDisclosure',
    method: 'GET',
    path: '/api/v1/futures/adl-disclosure',
    product: 'derivatives',
    anonymous: false,
    summary: 'The auto-deleveraging disclosure, and whether this account has acknowledged it',
  },
  {
    name: 'ackAdlDisclosure',
    method: 'POST',
    path: '/api/v1/futures/adl-disclosure/ack',
    product: 'derivatives',
    anonymous: false,
    summary: 'Acknowledge the current auto-deleveraging disclosure',
  },
  {
    name: 'fetchAdlDisclosureEvents',
    method: 'GET',
    path: '/api/v1/futures/adl-events',
    product: 'derivatives',
    anonymous: false,
    summary: 'Auto-deleveraging events disclosed to this account',
  },
  {
    name: 'setLeverage',
    method: 'POST',
    path: '/api/v1/positions/leverage',
    product: 'derivatives',
    anonymous: false,
    summary: 'Change the leverage of an isolated position',
    refusals: [{ status: '400', codes: ['trade.leverage_too_high', 'trade.leverage_would_liquidate', 'trade.insufficient_margin'] }],
  },
  {
    name: 'setMarginMode',
    method: 'POST',
    path: '/api/v1/positions/margin-mode',
    product: 'derivatives',
    anonymous: false,
    summary: 'Mounted only to refuse: margin mode is chosen when a position opens',
    refusals: [{ status: '501', codes: ['trade.margin_mode_unsupported'] }],
  },
  // Accounts
  {
    name: 'fetchBalance',
    method: 'GET',
    path: '/api/v1/account/balance',
    product: 'accounts',
    anonymous: false,
    summary: 'Account balances',
  },
  {
    name: 'fetchTradingFees',
    method: 'GET',
    path: '/api/v1/account/fees',
    product: 'accounts',
    anonymous: false,
    summary: 'Maker and taker fee rates',
  },
  {
    name: 'fetchMyTrades',
    method: 'GET',
    path: '/api/v1/account/trades',
    product: 'accounts',
    anonymous: false,
    summary: 'The account’s own fills',
  },
  {
    name: 'fetchLedger',
    method: 'GET',
    path: '/api/v1/ledger',
    product: 'accounts',
    anonymous: false,
    summary: 'The account’s balance changes, newest first',
  },
  {
    name: 'createStatementExport',
    method: 'POST',
    path: '/api/v1/statements',
    product: 'accounts',
    anonymous: false,
    summary: 'Ask for a statement of orders, trades and balance changes over a finished range',
  },
  {
    name: 'fetchStatementExport',
    method: 'GET',
    path: '/api/v1/statements/:id',
    product: 'accounts',
    anonymous: false,
    summary: 'One statement request and its state',
  },
  {
    name: 'fetchStatementExportFile',
    method: 'GET',
    path: '/api/v1/statements/:id/file',
    product: 'accounts',
    anonymous: false,
    summary: 'A finished statement as a CSV file',
  },
];

export type Stream = { channel: string; product: Product; private: boolean };

/** `WS_CHANNELS` in the contract, by product. A private channel carries only the signed-in principal's own data. */
export const STREAM_REFERENCE: readonly Stream[] = [
  { channel: 'orderbook', product: 'spot', private: false },
  { channel: 'trades', product: 'spot', private: false },
  { channel: 'ticker', product: 'spot', private: false },
  { channel: 'ohlcv', product: 'spot', private: false },
  { channel: 'orders', product: 'spot', private: true },
  { channel: 'positions', product: 'derivatives', private: true },
  { channel: 'balance', product: 'accounts', private: true },
];

/** Scopes that never reach a key (`INTERACTIVE_ONLY_SCOPES` in packages/auth): withdrawing is not reachable from the API. */
export const NEVER_ON_A_KEY = ['trade:withdraw'] as const;

export const routeLine = (route: Pick<RestRoute, 'method' | 'path'>) => `${route.method} ${route.path}`;

/** The permission-to-endpoint table: one row per scope with every route a key needs it for. */
export function permissionTable(): { scope: Scope; routes: RestRoute[] }[] {
  return (['trade:read', 'trade:write'] as const).map((scope) => ({
    scope,
    routes: REST_REFERENCE.filter((route) => scopeFor(route.method) === scope),
  }));
}

const openApiPath = (path: string) => path.replace(/:(\w+)/g, '{$1}');
const pathParams = (path: string) => [...path.matchAll(/:(\w+)/g)].map((match) => match[1]!);

/** The OpenAPI 3.0 document for the trading REST routes. No `servers`: no host is set, and none is guessed. */
export function openApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of REST_REFERENCE) {
    const scope = scopeFor(route.method);
    const responses: Record<string, { description: string }> = {
      '200': { description: 'Success' },
      ...(route.anonymous
        ? {}
        : { '401': { description: 'No credential, or one that did not verify (AuthenticationError, auth.required)' } }),
      '403': { description: `An API key without ${scope} (PermissionDenied, scope.denied); the body links the permission table` },
      '429': { description: 'Over the rate limit (edge.rate_limited); retry after retryAfterSeconds' },
    };
    for (const refusal of route.refusals ?? []) responses[refusal.status] = { description: `Refused: ${refusal.codes.join(', ')}` };
    const params = pathParams(route.path);
    (paths[openApiPath(route.path)] ??= {})[route.method.toLowerCase()] = {
      operationId: route.name,
      summary: route.summary,
      tags: [route.product],
      ...(params.length ? { parameters: params.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })) } : {}),
      security: route.anonymous ? [{}, { apiKey: [] }] : [{ apiKey: [] }],
      'x-scope': scope,
      'x-anonymous': route.anonymous,
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
        'Every trading REST route. x-scope is the permission an API key needs; a route with x-anonymous true also answers ' +
        'without a key. x-cost is what one call takes from the rate-limit bucket. Amounts are decimal strings. No server ' +
        'is listed: the owner has not set the hosts (see /developers/hosts).',
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
        request: {
          method: route.method,
          header: route.anonymous ? [] : [{ key: 'Authorization', value: 'Bearer {{apiKey}}' }],
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
