import { createHmac } from 'node:crypto';
import { formatAmount } from '@intafaced/ledger-client/money';
import {
  readDecimal,
  readInteger,
  parseUnifiedSymbol,
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
import { assertCredentialVenue } from './credential-guard.js';
import { assertFillReportMatchesStatus, assertKnownOrderStatus, throwVenueTransportFailure } from './order-outcome-honesty.js';
import { assertTradeBookPayoutGradeBeforePlace } from '../trade-payout-gate.js';

const REST_BASE = 'https://api.bybit.com';
const RECV_WINDOW = '5000';
/** Same numbers as `BYBIT_SPOT_RATE_LIMIT` / `BYBIT_IP_BACKOFF_MS` — do not import (cycle). */
const RATE_LIMIT = { venueId: 'bybit-spot', capacity: 600, windowMs: 5_000 } as const;
const IP_BACKOFF_MS = 600_000;
const RATE_LIMIT_RET_CODES = new Set([10_006, 10_018]);

const VENUE: VenueDescriptor = {
  id: 'bybit-spot',
  displayName: 'Bybit Spot',
  kind: 'external-cex',
  sequencedDepth: true,
};

function venueSymbolOf(unified: string): string {
  if (parseUnifiedSymbol(unified) === null) {
    throw new VenueUnavailableError(VENUE.id, 'malformed', `symbol ${unified || '(empty)'} is not unified BASE/QUOTE spot`);
  }
  return unified.replace(/[/:]/g, '').toUpperCase();
}

export function signBybitV5(timestamp: string, apiKey: string, recvWindow: string, secret: string, payload: string): string {
  return createHmac('sha256', secret)
    .update(timestamp + apiKey + recvWindow + payload)
    .digest('hex');
}

function encodeQuery(params: Readonly<Record<string, string>>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${key}=${encodeURIComponent(params[key]!)}`)
    .join('&');
}

const ORDER_STATUS: Record<string, VenueOrder['status']> = {
  New: 'open',
  Unfilled: 'open',
  PartiallyFilled: 'partially_filled',
  Filled: 'filled',
  Cancelled: 'canceled',
  Canceled: 'canceled',
  PartiallyFilledCanceled: 'canceled',
  Rejected: 'rejected',
};

export function mapBybitSpotOrder(row: Record<string, unknown>, unified: string, now: Date): VenueOrder {
  const statusRaw = String(row.orderStatus ?? '');
  const status = ORDER_STATUS[statusRaw];
  assertKnownOrderStatus(VENUE.id, status, statusRaw, 'order status');
  const orig = readDecimal(row.qty, VENUE.id, 'qty');
  const executed = readDecimal(row.cumExecQty ?? '0', VENUE.id, 'cumExecQty');
  if (orig <= 0n) throw new VenueUnavailableError(VENUE.id, 'malformed', 'qty must be positive');
  if (executed < 0n) throw new VenueUnavailableError(VENUE.id, 'malformed', 'cumExecQty must not be negative');
  const remaining = orig - executed;
  if (remaining < 0n) {
    throw new VenueUnavailableError(VENUE.id, 'malformed', 'cumExecQty exceeds qty');
  }
  const avgRaw = row.avgPrice;
  let averagePrice: VenueOrder['averagePrice'] = null;
  if (executed > 0n) {
    averagePrice = readDecimal(avgRaw, VENUE.id, 'avgPrice');
    if (averagePrice <= 0n)
      throw new VenueUnavailableError(VENUE.id, 'malformed', 'avgPrice must be positive after a fill — outcome unknown, not a fill');
  }
  const typeRaw = String(row.orderType ?? '').toLowerCase();
  if (typeRaw !== 'market' && typeRaw !== 'limit') {
    throw new VenueUnavailableError(VENUE.id, 'malformed', `orderType ${typeRaw || '(empty)'} is not a known Bybit spot type`);
  }
  const type: VenueOrder['type'] = typeRaw;
  const price =
    type === 'market' || row.price === undefined || row.price === null || String(row.price) === '0'
      ? null
      : readDecimal(row.price, VENUE.id, 'price');
  if (type === 'limit' && (price === null || price <= 0n)) {
    throw new VenueUnavailableError(VENUE.id, 'malformed', 'limit order price must be positive');
  }
  const createdRaw = row.createdTime ?? row.updatedTime;
  const createdAt = createdRaw === undefined || createdRaw === null ? now : new Date(readInteger(createdRaw, VENUE.id, 'createdTime'));
  const sideRaw = String(row.side ?? '').toLowerCase();
  if (sideRaw !== 'buy' && sideRaw !== 'sell') {
    throw new VenueUnavailableError(VENUE.id, 'malformed', `side ${sideRaw || '(empty)'} is not a known Bybit side`);
  }
  const venueOrderId = String(row.orderId ?? '').trim();
  const clientOrderId = String(row.orderLinkId ?? '').trim();
  if (!venueOrderId) throw new VenueUnavailableError(VENUE.id, 'malformed', 'orderId is missing');
  if (!clientOrderId) throw new VenueUnavailableError(VENUE.id, 'malformed', 'orderLinkId is missing');
  assertFillReportMatchesStatus(VENUE.id, status, executed, averagePrice);
  return {
    venueId: VENUE.id,
    venueOrderId,
    clientOrderId,
    symbol: unified,
    side: sideRaw,
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

export interface BybitSpotTradeOptions {
  readonly http?: HttpPort;
  readonly restBase?: string;
  readonly clock?: () => number;
  readonly governor?: RateLimitGovernor;
  /** Depth for the payout-grade snapshot. Unset refuses — never invent 200. */
  readonly snapshotLimit?: number;
}

export class BybitSpotTrade implements TradeAdapter {
  readonly venue = VENUE;
  readonly #credentials: VenueCredentials | null;
  readonly #http: HttpPort;
  readonly #restBase: string;
  readonly #clock: () => number;
  readonly #governor: RateLimitGovernor;
  readonly #snapshotLimit: number | undefined;

  constructor(credentials: VenueCredentials | null = null, options: BybitSpotTradeOptions = {}) {
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
    if (request.amount <= 0n) throw new VenueUnavailableError(VENUE.id, 'malformed', 'order amount must be positive');
    if (!request.clientOrderId.trim()) throw new VenueUnavailableError(VENUE.id, 'malformed', 'clientOrderId is required');
    if (request.type === 'limit' && request.price !== undefined && request.price !== null && request.price <= 0n) {
      throw new VenueUnavailableError(VENUE.id, 'malformed', 'limit order price must be positive');
    }
    venueSymbolOf(request.symbol);
    await assertTradeBookPayoutGradeBeforePlace(VENUE.id, request.symbol, {
      http: this.#http,
      clock: this.#clock,
      limit: this.#snapshotLimit,
    });
    if (request.reduceOnly) {
      throw new VenueUnavailableError(VENUE.id, 'not_ready', 'spot has no reduceOnly');
    }
    if (request.type === 'limit' && (request.price === undefined || request.price === null)) {
      throw new VenueUnavailableError(VENUE.id, 'malformed', 'limit order requires price');
    }
    if (request.type === 'market' && request.price !== undefined) {
      throw new VenueUnavailableError(VENUE.id, 'malformed', 'market order must not carry price');
    }
    const payload: Record<string, string> = {
      category: 'spot',
      symbol: venueSymbolOf(request.symbol),
      side: request.side === 'sell' ? 'Sell' : 'Buy',
      orderType: request.type === 'market' ? 'Market' : 'Limit',
      qty: formatAmount(request.amount),
      orderLinkId: request.clientOrderId,
    };
    if (request.type === 'limit') {
      payload.price = formatAmount(request.price!);
      payload.timeInForce = request.postOnly ? 'PostOnly' : 'GTC';
    } else {
      // Unified amounts are base quantity; Bybit market buys default to quote value.
      payload.marketUnit = 'baseCoin';
    }
    await this.#signed('POST', '/v5/order/create', payload, keys, 'placeOrder');
    return this.fetchOrder(request.symbol, request.clientOrderId);
  }

  async cancelOrder(symbol: string, clientOrderId: string): Promise<VenueOrder> {
    const keys = requireCredentials(VENUE.id, 'cancelOrder', this.#credentials);
    await this.#signed(
      'POST',
      '/v5/order/cancel',
      { category: 'spot', symbol: venueSymbolOf(symbol), orderLinkId: clientOrderId },
      keys,
      'cancelOrder',
    );
    return this.fetchOrder(symbol, clientOrderId);
  }

  async fetchOrder(symbol: string, clientOrderId: string): Promise<VenueOrder> {
    const keys = requireCredentials(VENUE.id, 'fetchOrder', this.#credentials);
    const body = await this.#signed(
      'GET',
      '/v5/order/realtime',
      { category: 'spot', symbol: venueSymbolOf(symbol), orderLinkId: clientOrderId },
      keys,
      'fetchOrder',
    );
    const list = (body.result as { list?: unknown })?.list;
    if (!Array.isArray(list) || list.length === 0) {
      throw new VenueUnavailableError(VENUE.id, 'unreachable', 'fetchOrder: realtime list is empty');
    }
    const row = list[0];
    if (!row || typeof row !== 'object') {
      throw new VenueUnavailableError(VENUE.id, 'malformed', 'fetchOrder row is not an object');
    }
    return mapBybitSpotOrder(row as Record<string, unknown>, symbol, new Date(this.#clock()));
  }

  async openOrders(symbol?: string): Promise<VenueOrder[]> {
    const keys = requireCredentials(VENUE.id, 'openOrders', this.#credentials);
    if (!symbol) {
      throw new VenueUnavailableError(
        VENUE.id,
        'malformed',
        'openOrders requires a symbol — Bybit spot has no all-markets list without settleCoin',
      );
    }
    const body = await this.#signed(
      'GET',
      '/v5/order/realtime',
      { category: 'spot', openOnly: '1', symbol: venueSymbolOf(symbol) },
      keys,
      'openOrders',
    );
    const list = (body.result as { list?: unknown })?.list;
    if (!Array.isArray(list)) {
      throw new VenueUnavailableError(VENUE.id, 'malformed', 'openOrders did not return a list');
    }
    const now = new Date(this.#clock());
    return list.map((row) => {
      if (!row || typeof row !== 'object') {
        throw new VenueUnavailableError(VENUE.id, 'malformed', 'openOrders row is not an object');
      }
      return mapBybitSpotOrder(row as Record<string, unknown>, symbol, now);
    });
  }

  async #signed(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, string>,
    keys: VenueCredentials,
    operation: string,
  ): Promise<Record<string, unknown>> {
    const post = this.#http.post?.bind(this.#http);
    if (method === 'POST' && !post) {
      throw new VenueUnavailableError(VENUE.id, 'not_ready', `${operation}: HTTP POST port is not wired`);
    }

    const now = this.#clock();
    const decision = this.#governor.tryAcquire(1, now);
    if (!decision.admitted) {
      throw new VenueUnavailableError(VENUE.id, 'rate_limited', `${decision.detail} (retry in ${decision.retryAfterMs}ms)`);
    }

    const timestamp = String(now);
    const payload = method === 'GET' ? encodeQuery(params) : JSON.stringify(params);
    const sign = signBybitV5(timestamp, keys.apiKey, RECV_WINDOW, keys.apiSecret, payload);
    const headers = {
      'X-BAPI-API-KEY': keys.apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-SIGN': sign,
      'X-BAPI-RECV-WINDOW': RECV_WINDOW,
    };
    const url = method === 'GET' ? `${this.#restBase}${path}?${payload}` : `${this.#restBase}${path}`;

    let response;
    try {
      if (method === 'GET') response = await this.#http.get(url, { headers });
      else response = await post!(url, { headers, jsonBody: params });
    } catch (error) {
      throwVenueTransportFailure(VENUE.id, method, path, error);
    }

    const accessTooFrequent =
      response.status === 403 ||
      (typeof response.body === 'object' &&
        response.body !== null &&
        /access too frequent/i.test(String((response.body as { retMsg?: unknown }).retMsg ?? '')));
    if (response.status === 429 || accessTooFrequent) {
      this.#governor.observeVenueBackoff(IP_BACKOFF_MS, `HTTP ${response.status}`, this.#clock());
      throw new VenueUnavailableError(
        VENUE.id,
        'rate_limited',
        `${VENUE.id} answered ${response.status}; backing off for ${IP_BACKOFF_MS}ms`,
      );
    }

    if (response.status < 200 || response.status >= 300 || response.body === null || typeof response.body !== 'object') {
      throw new VenueUnavailableError(VENUE.id, 'unreachable', `${operation} HTTP ${response.status}`);
    }

    const body = response.body as Record<string, unknown>;
    if (typeof body.retCode !== 'number') {
      throw new VenueUnavailableError(VENUE.id, 'malformed', `${operation} answered with no numeric retCode`);
    }
    if (RATE_LIMIT_RET_CODES.has(body.retCode)) {
      this.#governor.observeVenueBackoff(IP_BACKOFF_MS, `retCode ${body.retCode}`, this.#clock());
      throw new VenueUnavailableError(
        VENUE.id,
        'rate_limited',
        `${VENUE.id} answered retCode ${body.retCode} inside HTTP 200; backing off for ${IP_BACKOFF_MS}ms`,
      );
    }
    if (body.retCode !== 0) {
      const retMsg = typeof body.retMsg === 'string' ? body.retMsg : '';
      throw new VenueUnavailableError(VENUE.id, 'unreachable', `${operation} retCode ${body.retCode} (${retMsg})`);
    }
    return body;
  }
}
