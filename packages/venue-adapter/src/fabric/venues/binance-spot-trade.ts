import { createHmac } from 'node:crypto';
import { div, formatAmount, SCALE, type Amount } from '@intafaced/ledger-client/money';
import {
  readDecimal,
  readInteger,
  requireCredentials,
  VenueUnavailableError,
  type ClosedOrderWindow,
  type PlaceOrderRequest,
  type TradeAdapter,
  type VenueCredentials,
  type VenueDescriptor,
  type VenueOrder,
  type VenueUnavailableReason,
} from '@intafaced/venue-contracts';
import { fetchHttpPort, type HttpPort } from '../transport.js';
import { RateLimitGovernor } from '../rate-limit.js';
import { assertCredentialVenue } from './credential-guard.js';
import {
  assertFillReportMatchesStatus,
  assertKnownOrderStatus,
  rethrowWithSent,
  throwVenueTransportFailure,
} from './order-outcome-honesty.js';
import { assertTradeBookPayoutGradeBeforePlace } from '../trade-payout-gate.js';

const REST_BASE = 'https://api.binance.com';

function venueSymbolOf(unified: string): string {
  return unified.replace(/[/:]/g, '').toUpperCase();
}

function retryAfterFrom(header: string | null, fallbackMs = 60_000): number {
  if (!header) return fallbackMs;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return fallbackMs;
  return Math.ceil(seconds * 1_000);
}

const RATE_LIMIT = { venueId: 'binance-spot', capacity: 6_000, windowMs: 60_000 } as const;

const VENUE: VenueDescriptor = {
  id: 'binance-spot',
  displayName: 'Binance Spot',
  kind: 'external-cex',
  sequencedDepth: true,
};

function unavailable(reason: VenueUnavailableReason, message: string, sent: boolean): never {
  throw new VenueUnavailableError(VENUE.id, reason, message, sent);
}

/** Binance history pages are not proof of a miss once they hit this cap. */
const HISTORY_PAGE = 1000;
/** Binance rejects a myTrades window longer than 24h. Stay strictly inside it. */
const HISTORY_CHUNK_MS = 24 * 60 * 60 * 1000 - 1;

function isBinanceOrderMissing(error: unknown): boolean {
  return error instanceof VenueUnavailableError && /order does not exist/i.test(error.message);
}

function sameId(left: unknown, right: string): boolean {
  if (left === undefined || left === null) return false;
  return String(left).trim() === right;
}

export function signBinanceQuery(params: Readonly<Record<string, string>>, secret: string): string {
  const query = Object.keys(params)
    .sort()
    .map((key) => `${key}=${encodeURIComponent(params[key]!)}`)
    .join('&');
  const signature = createHmac('sha256', secret).update(query).digest('hex');
  return `${query}&signature=${signature}`;
}

const BINANCE_ORDER_STATUS: Record<string, VenueOrder['status']> = {
  NEW: 'open',
  PARTIALLY_FILLED: 'partially_filled',
  FILLED: 'filled',
  CANCELED: 'canceled',
  PENDING_CANCEL: 'open',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  EXPIRED_IN_MATCH: 'expired',
};

/**
 * Sum fill commissions that share one asset.
 * A missing field, or two assets, is unknown — never treated as zero.
 */
export function sumBinanceFillCommission(fills: unknown): { feePaid: Amount | null; feeAsset: string | null } {
  if (!Array.isArray(fills) || fills.length === 0) return { feePaid: null, feeAsset: null };
  const byAsset = new Map<string, Amount>();
  for (const fill of fills) {
    if (!fill || typeof fill !== 'object') return { feePaid: null, feeAsset: null };
    const row = fill as Record<string, unknown>;
    if (row.commission === undefined || row.commission === null) return { feePaid: null, feeAsset: null };
    const assetRaw = row.commissionAsset;
    if (typeof assetRaw !== 'string' || assetRaw.trim().length === 0) return { feePaid: null, feeAsset: null };
    let commission: Amount;
    try {
      commission = readDecimal(row.commission, VENUE.id, 'commission');
    } catch {
      return { feePaid: null, feeAsset: null };
    }
    const asset = assetRaw.trim().toUpperCase();
    byAsset.set(asset, (byAsset.get(asset) ?? 0n) + commission);
  }
  if (byAsset.size !== 1) return { feePaid: null, feeAsset: null };
  const [feeAsset, feePaid] = [...byAsset.entries()][0]!;
  return { feePaid, feeAsset: feePaid > 0n ? feeAsset : null };
}

/**
 * Taker-sell commission as a fraction of quote notional.
 *
 * Binance applies a non-zero special rate in place of the standard rate, then
 * adds tax. A BNB discount means the fee may not be taken in the quote asset,
 * which this book cannot subtract from USDT, so that answer is unknown.
 * A reported zero is a rate. A missing field is not.
 */
export function binanceTakerSellCommissionRate(body: unknown): Amount | null {
  if (!body || typeof body !== 'object') return null;
  const row = body as Record<string, unknown>;
  const discount = row.discount;
  if (discount && typeof discount === 'object') {
    const flag = discount as Record<string, unknown>;
    if (flag.enabledForAccount === true || flag.enabledForSymbol === true) return null;
  }
  const standard = commissionLeg(row.standardCommission);
  const special = commissionLeg(row.specialCommission);
  const tax = commissionLeg(row.taxCommission);
  if (!standard || !special || !tax) return null;
  const taker = special.taker > 0n ? special.taker : standard.taker;
  const seller = special.seller > 0n ? special.seller : standard.seller;
  const total = taker + seller + tax.taker + tax.seller;
  if (total < 0n || total >= SCALE) return null;
  return total;
}

function commissionLeg(raw: unknown): { taker: Amount; seller: Amount } | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  try {
    const taker = readDecimal(row.taker, VENUE.id, 'taker');
    const seller = readDecimal(row.seller, VENUE.id, 'seller');
    if (taker < 0n || seller < 0n) return null;
    return { taker, seller };
  } catch {
    return null;
  }
}

/** Tick, step and min notional. Any missing filter is unknown — no invented tick. */
export function binanceSymbolFilters(raw: Record<string, unknown>): {
  tickSize: Amount;
  stepSize: Amount;
  minNotional: Amount;
} | null {
  if (raw.status !== 'TRADING') return null;
  const filters = Array.isArray(raw.filters) ? (raw.filters as Record<string, unknown>[]) : [];
  const ofType = (type: string) => filters.find((filter) => filter.filterType === type);
  const price = ofType('PRICE_FILTER');
  const lot = ofType('LOT_SIZE');
  const notional = ofType('NOTIONAL') ?? ofType('MIN_NOTIONAL');
  if (!price || !lot || !notional) return null;
  try {
    const tickSize = readDecimal(price.tickSize, VENUE.id, 'tickSize');
    const stepSize = readDecimal(lot.stepSize, VENUE.id, 'stepSize');
    const minNotional = readDecimal(notional.minNotional, VENUE.id, 'minNotional');
    if (tickSize <= 0n || stepSize <= 0n || minNotional < 0n) return null;
    return { tickSize, stepSize, minNotional };
  } catch {
    return null;
  }
}

export function mapBinanceSpotOrder(body: Record<string, unknown>, unified: string, now: Date, sent = false): VenueOrder {
  const fail = (message: string): never => {
    throw new VenueUnavailableError(VENUE.id, 'malformed', message, sent);
  };
  const statusRaw = String(body.status ?? '');
  const status = BINANCE_ORDER_STATUS[statusRaw];
  assertKnownOrderStatus(VENUE.id, status, statusRaw, 'order status', sent);
  const orig = readDecimal(body.origQty, VENUE.id, 'origQty');
  const executed = readDecimal(body.executedQty, VENUE.id, 'executedQty');
  if (orig <= 0n) fail('origQty must be positive');
  if (executed < 0n) fail('executedQty must not be negative');
  const remaining = orig - executed;
  if (remaining < 0n) fail('executedQty exceeds origQty');
  const quote = body.cummulativeQuoteQty;
  let averagePrice: VenueOrder['averagePrice'] = null;
  const quoteAmt = quote === undefined || quote === null ? 0n : readDecimal(quote, VENUE.id, 'cummulativeQuoteQty');
  if (quoteAmt < 0n) fail('cummulativeQuoteQty must not be negative');
  if ((executed === 0n) !== (quoteAmt === 0n)) {
    fail('executedQty and cummulativeQuoteQty must either both be zero or both be positive');
  }
  if (executed > 0n) {
    averagePrice = div(quoteAmt, executed);
  }
  const typeRaw = String(body.type ?? '').toUpperCase();
  if (!['LIMIT', 'LIMIT_MAKER', 'MARKET'].includes(typeRaw)) {
    fail(`order type ${typeRaw || '(empty)'} is not a known Binance spot type`);
  }
  const type: VenueOrder['type'] = typeRaw === 'MARKET' ? 'market' : 'limit';
  const price =
    type === 'market' || body.price === undefined || body.price === null || String(body.price) === '0.00000000'
      ? null
      : readDecimal(body.price, VENUE.id, 'price');
  if (type === 'limit' && (price === null || price <= 0n)) fail('limit order price must be positive');
  const transact = body.transactTime ?? body.updateTime ?? body.time;
  const createdAt = transact === undefined || transact === null ? now : new Date(readInteger(transact, VENUE.id, 'transactTime'));
  const sideRaw = String(body.side ?? '').toUpperCase();
  if (sideRaw !== 'BUY' && sideRaw !== 'SELL') {
    fail(`order side ${sideRaw || '(empty)'} is not a known Binance side`);
  }
  const venueOrderId = body.orderId === undefined || body.orderId === null ? '' : String(body.orderId).trim();
  const clientOrderId = String(body.clientOrderId ?? body.origClientOrderId ?? '').trim();
  if (!venueOrderId || venueOrderId === '0') fail('orderId is missing or invalid');
  if (!clientOrderId) fail('clientOrderId is missing');
  assertFillReportMatchesStatus(VENUE.id, status, executed, averagePrice, sent);
  const commission = Array.isArray(body.fills) ? sumBinanceFillCommission(body.fills) : { feePaid: null, feeAsset: null };
  return {
    venueId: VENUE.id,
    venueOrderId,
    clientOrderId,
    symbol: unified,
    side: sideRaw === 'SELL' ? 'sell' : 'buy',
    type,
    price,
    amount: orig,
    filled: executed,
    remaining,
    averagePrice,
    status,
    feePaid: commission.feePaid,
    feeAsset: commission.feeAsset,
    createdAt,
    observedAt: now,
  };
}

export interface BinanceSpotTradeOptions {
  readonly http?: HttpPort;
  readonly restBase?: string;
  readonly clock?: () => number;
  readonly governor?: RateLimitGovernor;
  /** Depth for the payout-grade snapshot. Unset refuses — never invent 1000. */
  readonly snapshotLimit?: number;
}

export class BinanceSpotTrade implements TradeAdapter {
  readonly venue = VENUE;
  readonly #credentials: VenueCredentials | null;
  readonly #http: HttpPort;
  readonly #restBase: string;
  readonly #clock: () => number;
  readonly #governor: RateLimitGovernor;
  readonly #snapshotLimit: number | undefined;

  constructor(credentials: VenueCredentials | null = null, options: BinanceSpotTradeOptions = {}) {
    if (credentials) {
      assertCredentialVenue(VENUE.id, credentials);
      requireCredentials(VENUE.id, 'construct', credentials);
    }
    this.#credentials = credentials;
    this.#http = options.http ?? fetchHttpPort();
    this.#restBase = options.restBase ?? REST_BASE;
    this.#clock = options.clock ?? Date.now;
    this.#governor = options.governor ?? new RateLimitGovernor(RATE_LIMIT, this.#clock());
    this.#snapshotLimit = options.snapshotLimit;
  }

  async placeOrder(request: PlaceOrderRequest): Promise<VenueOrder> {
    const keys = requireCredentials(VENUE.id, 'placeOrder', this.#credentials);
    if (request.clientOrderId.length > 36) {
      unavailable('malformed', 'clientOrderId exceeds 36 characters', false);
    }
    try {
      await assertTradeBookPayoutGradeBeforePlace(VENUE.id, request.symbol, {
        http: this.#http,
        clock: this.#clock,
        limit: this.#snapshotLimit,
      });
    } catch (error) {
      rethrowWithSent(error, false);
    }
    if (request.type === 'market' && request.postOnly) {
      unavailable('malformed', 'post-only is a limit-order instruction; a market order cannot be post-only', false);
    }
    if (request.reduceOnly) unavailable('not_ready', 'spot has no reduceOnly', false);
    if (request.type === 'limit' && (request.price === undefined || request.price === null)) {
      unavailable('malformed', 'limit order requires price', false);
    }
    if (request.type === 'market' && request.price !== undefined) {
      unavailable('malformed', 'market order must not carry price', false);
    }
    const params: Record<string, string> = {
      symbol: venueSymbolOf(request.symbol),
      side: request.side.toUpperCase(),
      type: request.type === 'market' ? 'MARKET' : request.postOnly ? 'LIMIT_MAKER' : 'LIMIT',
      quantity: formatAmount(request.amount),
      newClientOrderId: request.clientOrderId,
      newOrderRespType: 'FULL',
      timestamp: String(this.#clock()),
      recvWindow: '5000',
    };
    if (request.type === 'limit') {
      params.price = formatAmount(request.price!);
      if (!request.postOnly) params.timeInForce = request.timeInForce ?? 'GTC';
    }
    const body = await this.#signedObject('POST', '/api/v3/order', params, keys, 'placeOrder', false);
    try {
      return await this.#withTrades(mapBinanceSpotOrder(body, request.symbol, new Date(this.#clock()), true), keys, true);
    } catch (error) {
      rethrowWithSent(error, true);
    }
  }

  async cancelOrder(symbol: string, clientOrderId: string): Promise<VenueOrder> {
    const keys = requireCredentials(VENUE.id, 'cancelOrder', this.#credentials);
    const body = await this.#signedObject(
      'DELETE',
      '/api/v3/order',
      {
        symbol: venueSymbolOf(symbol),
        origClientOrderId: clientOrderId,
        timestamp: String(this.#clock()),
        recvWindow: '5000',
      },
      keys,
      'cancelOrder',
    );
    return this.#withTrades(mapBinanceSpotOrder(body, symbol, new Date(this.#clock())), keys, false);
  }

  async fetchOrder(symbol: string, clientOrderId: string): Promise<VenueOrder> {
    const keys = requireCredentials(VENUE.id, 'fetchOrder', this.#credentials);
    const body = await this.#signedObject(
      'GET',
      '/api/v3/order',
      {
        symbol: venueSymbolOf(symbol),
        origClientOrderId: clientOrderId,
        timestamp: String(this.#clock()),
        recvWindow: '5000',
      },
      keys,
      'fetchOrder',
    );
    return this.#withTrades(mapBinanceSpotOrder(body, symbol, new Date(this.#clock())), keys, false);
  }

  /**
   * Closed-order proof. GET by clientOrderId, then allOrders and myTrades
   * across `window`. Any matching row is not a miss. A full history page is
   * not a miss either — the id may sit on the next page.
   */
  async fetchClosedOrder(symbol: string, clientOrderId: string, window?: ClosedOrderWindow): Promise<VenueOrder | null> {
    const keys = requireCredentials(VENUE.id, 'fetchClosedOrder', this.#credentials);
    try {
      return await this.fetchOrder(symbol, clientOrderId);
    } catch (error) {
      if (!isBinanceOrderMissing(error)) throw error;
    }
    if (!window || window.endTimeMs < window.startTimeMs) {
      unavailable('unreachable', 'fetchClosedOrder has no claim window — outcome unknown, not a miss', false);
    }
    const orderId = window.orderId?.trim() || null;
    const now = new Date(this.#clock());
    for (let start = window.startTimeMs; start <= window.endTimeMs; start += HISTORY_CHUNK_MS) {
      const end = Math.min(start + HISTORY_CHUNK_MS - 1, window.endTimeMs);
      const orders = await this.#historyArray(
        '/api/v3/allOrders',
        { symbol: venueSymbolOf(symbol), startTime: String(start), endTime: String(end), limit: String(HISTORY_PAGE) },
        keys,
        'allOrders',
      );
      const orderHit = orders.find(
        (row) =>
          sameId(row.clientOrderId, clientOrderId) ||
          sameId(row.origClientOrderId, clientOrderId) ||
          (orderId !== null && sameId(row.orderId, orderId)),
      );
      if (orderHit) return this.#withTrades(mapBinanceSpotOrder(orderHit, symbol, now), keys, false);
      const trades = await this.#historyArray(
        '/api/v3/myTrades',
        { symbol: venueSymbolOf(symbol), startTime: String(start), endTime: String(end), limit: String(HISTORY_PAGE) },
        keys,
        'myTrades',
      );
      const tradeHit = trades.find((row) => (orderId !== null && sameId(row.orderId, orderId)) || sameId(row.clientOrderId, clientOrderId));
      if (tradeHit) return this.#orderById(symbol, String(tradeHit.orderId ?? orderId ?? ''), keys, now);
    }
    if (orderId) {
      const byId = await this.#historyArray(
        '/api/v3/myTrades',
        { symbol: venueSymbolOf(symbol), orderId, limit: String(HISTORY_PAGE) },
        keys,
        'myTrades',
      );
      if (byId.length > 0) return this.#orderById(symbol, orderId, keys, now);
    }
    return null;
  }

  /** Quote-asset taker rate for a sell. Null when the venue does not say. */
  async commissionRate(symbol: string): Promise<Amount | null> {
    const keys = requireCredentials(VENUE.id, 'commissionRate', this.#credentials);
    const body = await this.#signedObject(
      'GET',
      '/api/v3/account/commission',
      { symbol: venueSymbolOf(symbol), timestamp: String(this.#clock()), recvWindow: '5000' },
      keys,
      'commissionRate',
    );
    return binanceTakerSellCommissionRate(body);
  }

  /** Exchange filters for one symbol. Null when the symbol or a filter is absent. */
  async symbolFilters(symbol: string): Promise<{ tickSize: Amount; stepSize: Amount; minNotional: Amount } | null> {
    const unified = venueSymbolOf(symbol);
    const url = `${this.#restBase}/api/v3/exchangeInfo?symbol=${encodeURIComponent(unified)}`;
    let response;
    try {
      response = await this.#http.get(url);
    } catch (error) {
      throwVenueTransportFailure(VENUE.id, 'GET', '/api/v3/exchangeInfo', error);
    }
    if (response.status < 200 || response.status >= 300 || response.body === null || typeof response.body !== 'object') {
      unavailable('unreachable', `exchangeInfo HTTP ${response.status}`, false);
    }
    const symbols = (response.body as { symbols?: unknown }).symbols;
    if (!Array.isArray(symbols) || symbols.length === 0) return null;
    const match = symbols.find((row) => row && typeof row === 'object' && String((row as { symbol?: unknown }).symbol) === unified);
    if (!match || typeof match !== 'object') return null;
    return binanceSymbolFilters(match as Record<string, unknown>);
  }

  async openOrders(symbol?: string): Promise<VenueOrder[]> {
    const keys = requireCredentials(VENUE.id, 'openOrders', this.#credentials);
    if (!symbol) {
      unavailable('not_ready', 'openOrders requires a unified symbol; native Binance symbols are not returned as unified symbols', false);
    }
    const params: Record<string, string> = {
      timestamp: String(this.#clock()),
      recvWindow: '5000',
    };
    params.symbol = venueSymbolOf(symbol);
    const body = await this.#signed('GET', '/api/v3/openOrders', params, keys, 'openOrders');
    if (!Array.isArray(body)) unavailable('malformed', 'openOrders did not return an array', false);
    const now = new Date(this.#clock());
    return body.map((row) => {
      if (!row || typeof row !== 'object') unavailable('malformed', 'openOrders row is not an object', false);
      return mapBinanceSpotOrder(row as Record<string, unknown>, symbol, now, false);
    });
  }

  async #orderById(symbol: string, orderId: string, keys: VenueCredentials, now: Date): Promise<VenueOrder> {
    if (!orderId.trim()) unavailable('unreachable', 'myTrades hit has no orderId — outcome unknown, not a miss', false);
    const body = await this.#signedObject(
      'GET',
      '/api/v3/order',
      { symbol: venueSymbolOf(symbol), orderId, timestamp: String(this.#clock()), recvWindow: '5000' },
      keys,
      'fetchOrder',
      false,
    );
    return this.#withTrades(mapBinanceSpotOrder(body, symbol, now, false), keys, false);
  }

  /** A short history page. A full page is not a miss: the id may be past the cap. */
  async #historyArray(
    path: string,
    params: Record<string, string>,
    keys: VenueCredentials,
    operation: string,
  ): Promise<Record<string, unknown>[]> {
    const body = await this.#signed(
      'GET',
      path,
      { ...params, timestamp: String(this.#clock()), recvWindow: '5000' },
      keys,
      operation,
      false,
    );
    if (!Array.isArray(body)) unavailable('malformed', `${operation} did not return an array`, false);
    if (body.length >= HISTORY_PAGE) {
      unavailable('unreachable', `${operation} history page is full — outcome unknown, not a miss`, false);
    }
    return body.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) unavailable('malformed', `${operation} row is not an object`, false);
      return row as Record<string, unknown>;
    });
  }

  async #withTrades(order: VenueOrder, keys: VenueCredentials, sent = false): Promise<VenueOrder> {
    if (order.filled <= 0n || order.feePaid !== null) return order;
    if (!order.venueOrderId) unavailable('malformed', 'myTrades requires orderId', sent);
    const body = await this.#signed(
      'GET',
      '/api/v3/myTrades',
      {
        symbol: venueSymbolOf(order.symbol),
        orderId: order.venueOrderId,
        timestamp: String(this.#clock()),
        recvWindow: '5000',
      },
      keys,
      'myTrades',
      sent,
    );
    if (!Array.isArray(body)) unavailable('malformed', 'myTrades did not return an array', sent);
    const fee = sumBinanceFillCommission(body);
    return { ...order, feePaid: fee.feePaid, feeAsset: fee.feeAsset };
  }

  async #signedObject(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Record<string, string>,
    keys: VenueCredentials,
    operation: string,
    sent = false,
  ): Promise<Record<string, unknown>> {
    const body = await this.#signed(method, path, params, keys, operation, sent);
    if (Array.isArray(body) || body === null || typeof body !== 'object') {
      unavailable('malformed', `${operation} did not return an object`, sent || operation === 'placeOrder');
    }
    return body;
  }

  /**
   * `sent` is true when the place POST was already dispatched before this call
   * (the follow-up myTrades read). The place POST itself flips to sent at the
   * moment it is handed to the transport, including a throw from that call.
   */
  async #signed(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Record<string, string>,
    keys: VenueCredentials,
    operation: string,
    sent = false,
  ): Promise<Record<string, unknown> | unknown[]> {
    let dispatched = sent;
    const fail = (reason: VenueUnavailableReason, message: string): never => {
      unavailable(reason, message, dispatched);
    };
    const post = this.#http.post?.bind(this.#http);
    const del = this.#http.delete?.bind(this.#http);
    if ((method === 'POST' && !post) || (method === 'DELETE' && !del)) {
      fail('not_ready', `${operation}: HTTP ${method} port is not wired`);
    }

    const now = this.#clock();
    const decision = this.#governor.tryAcquire(1, now);
    if (!decision.admitted) {
      fail('rate_limited', `${decision.detail} (retry in ${decision.retryAfterMs}ms)`);
    }

    if (operation === 'placeOrder') dispatched = true;
    const query = signBinanceQuery(params, keys.apiSecret);
    const url = `${this.#restBase}${path}?${query}`;
    const headers = { 'X-MBX-APIKEY': keys.apiKey };
    let response;
    try {
      if (method === 'GET') response = await this.#http.get(url, { headers });
      else if (method === 'POST') response = await post!(url, { headers });
      else response = await del!(url, { headers });
    } catch (error) {
      throwVenueTransportFailure(VENUE.id, method, path, error, dispatched);
    }

    if (response.status === 429 || response.status === 418) {
      const retryAfterMs = retryAfterFrom(response.header('Retry-After'));
      this.#governor.observeVenueBackoff(retryAfterMs, `HTTP ${response.status}`, this.#clock());
      fail('rate_limited', `${VENUE.id} answered ${response.status}; backing off for ${retryAfterMs}ms`);
    }

    if (response.status < 200 || response.status >= 300 || response.body === null || typeof response.body !== 'object') {
      const payload = response.body && typeof response.body === 'object' ? (response.body as { code?: unknown; msg?: unknown }) : null;
      const code = typeof payload?.code === 'number' ? payload.code : null;
      const msg = payload && 'msg' in payload ? String(payload.msg) : `HTTP ${response.status}`;
      const detail = code === null ? msg : `code ${code} (${msg})`;
      fail('unreachable', `${operation} ${detail}`);
    }

    if (Array.isArray(response.body)) return response.body;
    return response.body as Record<string, unknown>;
  }
}
