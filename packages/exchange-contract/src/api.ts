import type {
  Balances,
  CreateOrderRequest,
  FundingRate,
  Market,
  OHLCV,
  Order,
  OrderBook,
  Position,
  Ticker,
  Timeframe,
  Trade,
  TradingFee,
} from './schemas.js';

/**
 * The public exchange API, as a TypeScript interface.
 *
 * svc-trade implements this. The REST routes and WebSocket channels below are
 * the wire form of exactly these methods — one contract, two transports.
 *
 * Method names deliberately mirror CCXT's unified API, because that is what
 * makes an off-the-shelf integration off-the-shelf.
 */
export interface ExchangeApi {
  // ── Public ─────────────────────────────────────────────────────────────────
  fetchMarkets(): Promise<Market[]>;
  fetchTicker(symbol: string): Promise<Ticker>;
  fetchTickers(symbols?: string[]): Promise<Record<string, Ticker>>;
  fetchOrderBook(symbol: string, limit?: number): Promise<OrderBook>;
  fetchOHLCV(symbol: string, timeframe: Timeframe, since?: number, limit?: number): Promise<OHLCV[]>;
  fetchTrades(symbol: string, since?: number, limit?: number): Promise<Trade[]>;
  fetchFundingRate(symbol: string): Promise<FundingRate>;
  fetchTradingFees(): Promise<Record<string, TradingFee>>;

  // ── Private ────────────────────────────────────────────────────────────────
  fetchBalance(): Promise<Balances>;
  createOrder(request: CreateOrderRequest): Promise<Order>;
  cancelOrder(id: string, symbol: string): Promise<Order>;
  cancelAllOrders(symbol?: string): Promise<Order[]>;
  fetchOrder(id: string, symbol: string): Promise<Order>;
  fetchOpenOrders(symbol?: string, since?: number, limit?: number): Promise<Order[]>;
  fetchClosedOrders(symbol?: string, since?: number, limit?: number): Promise<Order[]>;
  fetchMyTrades(symbol?: string, since?: number, limit?: number): Promise<Trade[]>;
  fetchPositions(symbols?: string[]): Promise<Position[]>;
  setLeverage(leverage: string, symbol: string): Promise<void>;
  setMarginMode(mode: 'cross' | 'isolated', symbol: string): Promise<void>;
}

/**
 * REST route table. `svc-trade` mounts these behind the public API gateway
 * (§9), authenticated with the existing scoped API keys (§4.1).
 *
 * Scopes follow the split in packages/auth: reading a book is public, reading
 * your own orders needs `trade:read`, and placing one needs `trade:write`.
 * Withdrawal is deliberately absent — it is not reachable from an API key at
 * all (INTERACTIVE_ONLY_SCOPES), which is what protects a leaked bot key.
 */
export const REST_ROUTES = {
  // Public — no authentication.
  fetchMarkets: { method: 'GET', path: '/api/v1/markets', scope: null },
  fetchTicker: { method: 'GET', path: '/api/v1/ticker/:symbol', scope: null },
  fetchTickers: { method: 'GET', path: '/api/v1/tickers', scope: null },
  fetchOrderBook: { method: 'GET', path: '/api/v1/orderbook/:symbol', scope: null },
  fetchOHLCV: { method: 'GET', path: '/api/v1/ohlcv/:symbol', scope: null },
  fetchTrades: { method: 'GET', path: '/api/v1/trades/:symbol', scope: null },
  fetchFundingRate: { method: 'GET', path: '/api/v1/funding-rate/:symbol', scope: null },

  // Private.
  fetchTradingFees: { method: 'GET', path: '/api/v1/account/fees', scope: 'trade:read' },
  fetchBalance: { method: 'GET', path: '/api/v1/account/balance', scope: 'trade:read' },
  createOrder: { method: 'POST', path: '/api/v1/orders', scope: 'trade:write' },
  cancelOrder: { method: 'DELETE', path: '/api/v1/orders/:id', scope: 'trade:write' },
  cancelAllOrders: { method: 'DELETE', path: '/api/v1/orders', scope: 'trade:write' },
  fetchOrder: { method: 'GET', path: '/api/v1/orders/:id', scope: 'trade:read' },
  fetchOpenOrders: { method: 'GET', path: '/api/v1/orders/open', scope: 'trade:read' },
  fetchClosedOrders: { method: 'GET', path: '/api/v1/orders/closed', scope: 'trade:read' },
  fetchMyTrades: { method: 'GET', path: '/api/v1/account/trades', scope: 'trade:read' },
  fetchPositions: { method: 'GET', path: '/api/v1/positions', scope: 'trade:read' },
  setLeverage: { method: 'POST', path: '/api/v1/positions/leverage', scope: 'trade:write' },
  setMarginMode: { method: 'POST', path: '/api/v1/positions/margin-mode', scope: 'trade:write' },
} as const satisfies Record<string, { method: string; path: string; scope: string | null }>;

export type RestRouteName = keyof typeof REST_ROUTES;

/**
 * WebSocket channels, served by apps/ws-gateway (§2).
 *
 * Subscribe frame: `{ "op": "subscribe", "channel": "orderbook", "symbol": "BTC/USDT" }`
 * Private channels require a token in the connect frame and only ever carry the
 * authenticated principal's own data.
 */
export const WS_CHANNELS = {
  orderbook: { private: false, description: 'Depth snapshots and deltas, sequenced by engine nonce' },
  trades: { private: false, description: 'Public tape' },
  ticker: { private: false, description: '24h rolling statistics' },
  ohlcv: { private: false, description: 'Live candle updates' },
  orders: { private: true, scope: 'trade:read', description: "The principal's own order lifecycle" },
  positions: { private: true, scope: 'trade:read', description: "The principal's own positions and liquidation prices" },
  balance: { private: true, scope: 'trade:read', description: 'Ledger balance projection updates' },
} as const;

export type WsChannel = keyof typeof WS_CHANNELS;

/**
 * Rate limits, published because CCXT's throttler reads them. A bot that knows
 * the limit stays under it; a bot that has to discover it by being rejected
 * hammers the gateway.
 */
export const RATE_LIMITS = {
  /**
   * What svc-edge actually enforces (`EDGE_RATE_LIMIT_MAX` default 300 per
   * `EDGE_RATE_LIMIT_WINDOW_MS` default 60s). One bucket — public and private
   * share it. There is no separate order/weight governor.
   */
  publicPerMinute: 300,
  privatePerMinute: 300,
} as const;

/**
 * Most items in one batch cancel (`POST /api/v1/orders/cancel-batch`, SP-lifecycle-history-02).
 * One constant, shared with SP-conditional-algo-04. More refuses `trade.batch_too_large`.
 */
export const BATCH_CANCEL_MAX = 50;
