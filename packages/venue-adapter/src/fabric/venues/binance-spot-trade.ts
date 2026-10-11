import { createHmac } from 'node:crypto';
import { div, formatAmount } from '@intafaced/ledger-client/money';
import {
  readDecimal,
  readInteger,
  requireCredentials,
  VenueUnavailableError,
  type PlaceOrderRequest,
  type TradeAdapter,
  type VenueCredentials,
  type VenueDescriptor,
  type VenueOrder,
} from '@intafaced/venue-contracts';
import { fetchHttpPort, type HttpPort } from '../transport.js';
import { RateLimitGovernor } from '../rate-limit.js';
import { assertFillReportMatchesStatus, assertKnownOrderStatus, throwVenueTransportFailure } from './order-outcome-honesty.js';
import type { PayoutGradePolicy } from '../payout-grade.js';
import { assertTradeBookPayoutGradeBeforePlace } from '../trade-payout-gate.js';

const REST_BASE = 'https://api.binance.com';

function venueSymbolOf(unified: string): string {
  return unified.replace(/[/:]/g, '').toUpperCase();
}

export function retryAfterFrom(header: string | null, fallbackMs = 60_000): number {
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

export function mapBinanceSpotOrder(body: Record<string, unknown>, unified: string, now: Date): VenueOrder {
  const statusRaw = String(body.status ?? '');
  const status = BINANCE_ORDER_STATUS[statusRaw];
  assertKnownOrderStatus(VENUE.id, status, statusRaw, 'order status');
  const orig = readDecimal(body.origQty, VENUE.id, 'origQty');
  const executed = readDecimal(body.executedQty, VENUE.id, 'executedQty');
  if (orig <= 0n) {
    throw new VenueUnavailableError(VENUE.id, 'malformed', 'origQty must be positive');
  }
  if (executed < 0n) {
    throw new VenueUnavailableError(VENUE.id, 'malformed', 'executedQty must not be negative');
  }
  const remaining = orig - executed;
  if (remaining < 0n) {
    throw new VenueUnavailableError(VENUE.id, 'malformed', 'executedQty exceeds origQty');
  }
  const quote = body.cummulativeQuoteQty;
  let averagePrice: VenueOrder['averagePrice'] = null;
  const quoteAmt = quote === undefined || quote === null ? 0n : readDecimal(quote, VENUE.id, 'cummulativeQuoteQty');
  if (quoteAmt < 0n) {
    throw new VenueUnavailableError(VENUE.id, 'malformed', 'cummulativeQuoteQty must not be negative');
  }
  if ((executed === 0n) !== (quoteAmt === 0n)) {
    throw new VenueUnavailableError(
      VENUE.id,
      'malformed',
      'executedQty and cummulativeQuoteQty must either both be zero or both be positive',
    );
  }
  if (executed > 0n) {
    averagePrice = div(quoteAmt, executed);
  }
  const typeRaw = String(body.type ?? '').toUpperCase();
  if (!['LIMIT', 'LIMIT_MAKER', 'MARKET'].includes(typeRaw)) {
    throw new VenueUnavailableError(VENUE.id, 'malformed', `order type ${typeRaw || '(empty)'} is not a known Binance spot type`);
  }
  const type: VenueOrder['type'] = typeRaw === 'MARKET' ? 'market' : 'limit';
  const price =
    type === 'market' || body.price === undefined || body.price === null || String(body.price) === '0.00000000'
      ? null
      : readDecimal(body.price, VENUE.id, 'price');
  if (type === 'limit' && (price === null || price <= 0n)) {
    throw new VenueUnavailableError(VENUE.id, 'malformed', 'limit order price must be positive');
  }
  const transact = body.transactTime ?? body.updateTime ?? body.time;
  const createdAt = transact === undefined || transact === null ? now : new Date(readInteger(transact, VENUE.id, 'transactTime'));
  const sideRaw = String(body.side ?? '').toUpperCase();
  if (sideRaw !== 'BUY' && sideRaw !== 'SELL') {
    throw new VenueUnavailableError(VENUE.id, 'malformed', `order side ${sideRaw || '(empty)'} is not a known Binance side`);
  }
  const venueOrderId = body.orderId === undefined || body.orderId === null ? '' : String(body.orderId).trim();
  const clientOrderId = String(body.clientOrderId ?? body.origClientOrderId ?? '').trim();
  if (!venueOrderId || venueOrderId === '0') {
    throw new VenueUnavailableError(VENUE.id, 'malformed', 'orderId is missing or invalid');
  }
  if (!clientOrderId) {
    throw new VenueUnavailableError(VENUE.id, 'malformed', 'clientOrderId is missing');
  }
  assertFillReportMatchesStatus(VENUE.id, status, executed, averagePrice);
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
    feePaid: null,
    feeAsset: null,
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
  /** Caller floor forwarded to the payout gate. Omitted is not filled in. */
  readonly payoutPolicy?: PayoutGradePolicy | null;
}

export class BinanceSpotTrade implements TradeAdapter {
  readonly venue = VENUE;
  readonly #credentials: VenueCredentials | null;
  /** Caller-supplied port only. Absence is not a live fetch. */
  readonly #callerHttp: HttpPort | undefined;
  readonly #http: HttpPort;
  readonly #restBase: string;
  readonly #clock: () => number;
  readonly #governor: RateLimitGovernor;
  readonly #snapshotLimit: number | undefined;
  readonly #payoutPolicy: PayoutGradePolicy | null | undefined;

  constructor(credentials: VenueCredentials | null = null, options: BinanceSpotTradeOptions = {}) {
    if (credentials) requireCredentials(VENUE.id, 'construct', credentials);
    this.#credentials = credentials;
    this.#callerHttp = options.http;
    this.#http = options.http ?? fetchHttpPort();
    this.#restBase = options.restBase ?? REST_BASE;
    this.#clock = options.clock ?? Date.now;
    this.#governor = options.governor ?? new RateLimitGovernor(RATE_LIMIT, this.#clock());
    this.#snapshotLimit = options.snapshotLimit;
    this.#payoutPolicy = options.payoutPolicy;
  }

  async placeOrder(request: PlaceOrderRequest): Promise<VenueOrder> {
    const keys = requireCredentials(VENUE.id, 'placeOrder', this.#credentials);
    const http = this.#callerHttp;
    if (http === undefined) {
      throw new VenueUnavailableError(VENUE.id, 'not_ready', 'placeOrder: HTTP port is not wired');
    }
    if (request.type === 'limit') {
      const price = request.price;
      if (price === undefined || price === null) {
        throw new VenueUnavailableError(VENUE.id, 'malformed', 'limit order requires price');
      }
      if (price <= 0n) {
        throw new VenueUnavailableError(VENUE.id, 'malformed', 'limit order price must be positive');
      }
    }
    if (request.type === 'market' && request.price !== undefined) {
      throw new VenueUnavailableError(VENUE.id, 'malformed', 'market order must not carry price');
    }
    if (request.amount <= 0n) {
      throw new VenueUnavailableError(VENUE.id, 'malformed', 'amount must be positive');
    }
    await assertTradeBookPayoutGradeBeforePlace(VENUE.id, request.symbol, {
      http,
      clock: this.#clock,
      limit: this.#snapshotLimit,
      payoutPolicy: this.#payoutPolicy,
    });
    if (request.reduceOnly) {
      throw new VenueUnavailableError(VENUE.id, 'not_ready', 'spot has no reduceOnly');
    }
    if (request.type === 'market' && request.postOnly) {
      throw new VenueUnavailableError(VENUE.id, 'malformed', 'market order must not set postOnly');
    }
    const params: Record<string, string> = {
      symbol: venueSymbolOf(request.symbol),
      side: request.side.toUpperCase(),
      type: request.type === 'market' ? 'MARKET' : request.postOnly ? 'LIMIT_MAKER' : 'LIMIT',
      quantity: formatAmount(request.amount),
      newClientOrderId: request.clientOrderId,
      timestamp: String(this.#clock()),
      recvWindow: '5000',
    };
    if (request.type === 'limit') {
      params.price = formatAmount(request.price!);
      if (!request.postOnly) params.timeInForce = 'GTC';
    }
    const body = await this.#signed('POST', '/api/v3/order', params, keys, 'placeOrder');
    return mapBinanceSpotOrder(body, request.symbol, new Date(this.#clock()));
  }

  async cancelOrder(symbol: string, clientOrderId: string): Promise<VenueOrder> {
    const keys = requireCredentials(VENUE.id, 'cancelOrder', this.#credentials);
    const body = await this.#signed(
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
    return mapBinanceSpotOrder(body, symbol, new Date(this.#clock()));
  }

  async fetchOrder(symbol: string, clientOrderId: string): Promise<VenueOrder> {
    const keys = requireCredentials(VENUE.id, 'fetchOrder', this.#credentials);
    const body = await this.#signed(
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
    return mapBinanceSpotOrder(body, symbol, new Date(this.#clock()));
  }

  async openOrders(symbol?: string): Promise<VenueOrder[]> {
    const keys = requireCredentials(VENUE.id, 'openOrders', this.#credentials);
    if (!symbol) {
      throw new VenueUnavailableError(
        VENUE.id,
        'not_ready',
        'openOrders requires a unified symbol; native Binance symbols are not returned as unified symbols',
      );
    }
    const params: Record<string, string> = {
      timestamp: String(this.#clock()),
      recvWindow: '5000',
    };
    params.symbol = venueSymbolOf(symbol);
    const body = await this.#signed('GET', '/api/v3/openOrders', params, keys, 'openOrders');
    if (!Array.isArray(body)) {
      throw new VenueUnavailableError(VENUE.id, 'malformed', 'openOrders did not return an array');
    }
    const now = new Date(this.#clock());
    return body.map((row) => {
      if (!row || typeof row !== 'object') {
        throw new VenueUnavailableError(VENUE.id, 'malformed', 'openOrders row is not an object');
      }
      return mapBinanceSpotOrder(row as Record<string, unknown>, symbol, now);
    });
  }

  async #signed(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Record<string, string>,
    keys: VenueCredentials,
    operation: string,
  ): Promise<Record<string, unknown>> {
    const post = this.#http.post?.bind(this.#http);
    const del = this.#http.delete?.bind(this.#http);
    if ((method === 'POST' && !post) || (method === 'DELETE' && !del)) {
      throw new VenueUnavailableError(VENUE.id, 'not_ready', `${operation}: HTTP ${method} port is not wired`);
    }

    const now = this.#clock();
    const decision = this.#governor.tryAcquire(1, now);
    if (!decision.admitted) {
      throw new VenueUnavailableError(VENUE.id, 'rate_limited', `${decision.detail} (retry in ${decision.retryAfterMs}ms)`);
    }

    const query = signBinanceQuery(params, keys.apiSecret);
    const url = `${this.#restBase}${path}?${query}`;
    const headers = { 'X-MBX-APIKEY': keys.apiKey };
    let response;
    try {
      if (method === 'GET') response = await this.#http.get(url, { headers });
      else if (method === 'POST') response = await post!(url, { headers });
      else response = await del!(url, { headers });
    } catch (error) {
      throwVenueTransportFailure(VENUE.id, method, path, error);
    }

    if (response.status === 429 || response.status === 418) {
      const retryAfterMs = retryAfterFrom(response.header('Retry-After'));
      this.#governor.observeVenueBackoff(retryAfterMs, `HTTP ${response.status}`, this.#clock());
      throw new VenueUnavailableError(
        VENUE.id,
        'rate_limited',
        `${VENUE.id} answered ${response.status}; backing off for ${retryAfterMs}ms`,
      );
    }

    if (response.status < 200 || response.status >= 300 || response.body === null || typeof response.body !== 'object') {
      const msg =
        response.body && typeof response.body === 'object' && 'msg' in response.body
          ? String((response.body as { msg: unknown }).msg)
          : `HTTP ${response.status}`;
      throw new VenueUnavailableError(VENUE.id, 'unreachable', `${operation} ${msg}`);
    }

    return response.body as Record<string, unknown>;
  }
}
