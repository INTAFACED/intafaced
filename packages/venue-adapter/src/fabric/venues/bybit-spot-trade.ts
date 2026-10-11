import { createHmac } from 'node:crypto';
import { formatAmount } from '@intafaced/ledger-client/money';
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
  const remaining = orig - executed;
  if (remaining < 0n) {
    throw new VenueUnavailableError(VENUE.id, 'malformed', 'cumExecQty exceeds qty');
  }
  const avgRaw = row.avgPrice;
  let averagePrice: VenueOrder['averagePrice'] = null;
  if (executed > 0n && avgRaw !== undefined && avgRaw !== null && String(avgRaw) !== '0' && String(avgRaw) !== '0.00') {
    averagePrice = readDecimal(avgRaw, VENUE.id, 'avgPrice');
  }
  const typeRaw = String(row.orderType ?? '').toLowerCase();
  if (typeRaw !== 'limit' && typeRaw !== 'market') {
    throw new VenueUnavailableError(VENUE.id, 'malformed', `order type ${typeRaw || '(empty)'} is unknown`);
  }
  const type: VenueOrder['type'] = typeRaw;
  const price =
    type === 'market' || row.price === undefined || row.price === null || String(row.price) === '0' || String(row.price) === '0.00'
      ? null
      : readDecimal(row.price, VENUE.id, 'price');
  const createdRaw = row.createdTime ?? row.updatedTime;
  const createdAt = createdRaw === undefined || createdRaw === null ? now : new Date(readInteger(createdRaw, VENUE.id, 'createdTime'));
  assertFillReportMatchesStatus(VENUE.id, status, executed, averagePrice);
  const sideRaw = typeof row.side === 'string' ? row.side.toLowerCase() : '';
  let side: VenueOrder['side'];
  if (sideRaw === 'buy') side = 'buy';
  else if (sideRaw === 'sell') side = 'sell';
  else {
    throw new VenueUnavailableError(VENUE.id, 'malformed', `side ${sideRaw || '(empty)'} is not a known Bybit side`);
  }
  return {
    venueId: VENUE.id,
    venueOrderId: row.orderId === undefined || row.orderId === null ? null : String(row.orderId),
    clientOrderId: String(row.orderLinkId ?? ''),
    symbol: unified,
    side,
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

/** retCode 0 body. orderId is required; a present orderLinkId must be the client id sent. */
function ackOrderId(body: Record<string, unknown>, clientOrderId: string, operation: string): string {
  const result = body.result;
  if (result === null || typeof result !== 'object') {
    throw new VenueUnavailableError(VENUE.id, 'malformed', `${operation} ack is malformed`);
  }
  const row = result as Record<string, unknown>;
  const orderId = row.orderId;
  if (typeof orderId !== 'string' || orderId.length === 0) {
    throw new VenueUnavailableError(VENUE.id, 'malformed', `${operation} ack is malformed: orderId is missing`);
  }
  if (row.orderLinkId !== undefined && row.orderLinkId !== null && row.orderLinkId !== clientOrderId) {
    throw new VenueUnavailableError(VENUE.id, 'malformed', `${operation} ack orderLinkId does not match the client id`);
  }
  return orderId;
}

/**
 * First realtime or history row. An empty list is absent, not an outage.
 * A non-object entry is malformed, same as `fetchOrder`.
 */
function firstOrderRow(body: Record<string, unknown>, operation: string): Record<string, unknown> | null {
  const list = (body.result as { list?: unknown } | null)?.list;
  if (!Array.isArray(list) || list.length === 0) return null;
  const row = list[0];
  if (!row || typeof row !== 'object') {
    throw new VenueUnavailableError(VENUE.id, 'malformed', `${operation} row is not an object`);
  }
  return row as Record<string, unknown>;
}

/** Accepted place with no row yet. Size is the request. Price is not an execution. */
function openFromPlaceAck(request: PlaceOrderRequest, venueOrderId: string, now: Date): VenueOrder {
  return {
    venueId: VENUE.id,
    venueOrderId,
    clientOrderId: request.clientOrderId,
    symbol: request.symbol,
    side: request.side,
    type: request.type,
    price: request.type === 'market' ? null : request.price!,
    amount: request.amount,
    filled: 0n,
    remaining: request.amount,
    averagePrice: null,
    status: 'open',
    feePaid: null,
    feeAsset: null,
    createdAt: now,
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
  /** Caller floor forwarded to the payout gate. Omitted is not filled in. */
  readonly payoutPolicy?: PayoutGradePolicy | null;
}

export class BybitSpotTrade implements TradeAdapter {
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

  constructor(credentials: VenueCredentials | null = null, options: BybitSpotTradeOptions = {}) {
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
    if (request.type === 'market' && request.postOnly) {
      throw new VenueUnavailableError(VENUE.id, 'malformed', 'market order must not set postOnly');
    }
    const http = this.#callerHttp;
    if (http === undefined) {
      throw new VenueUnavailableError(VENUE.id, 'not_ready', 'placeOrder: HTTP port is not wired');
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
      // Spot market buy qty is quote notional unless marketUnit is baseCoin.
      payload.marketUnit = 'baseCoin';
    }
    const ack = await this.#signed('POST', '/v5/order/create', payload, keys, 'placeOrder');
    const orderId = ackOrderId(ack, request.clientOrderId, 'placeOrder');
    const row = await this.#rowAfterAck(request.symbol, request.clientOrderId, keys, 'placeOrder');
    if (row) return row;
    // Empty realtime and history after retCode 0 is a live order, not an outage.
    return openFromPlaceAck(request, orderId, new Date(this.#clock()));
  }

  async cancelOrder(symbol: string, clientOrderId: string): Promise<VenueOrder> {
    const keys = requireCredentials(VENUE.id, 'cancelOrder', this.#credentials);
    const ack = await this.#signed(
      'POST',
      '/v5/order/cancel',
      { category: 'spot', symbol: venueSymbolOf(symbol), orderLinkId: clientOrderId },
      keys,
      'cancelOrder',
    );
    const orderId = ackOrderId(ack, clientOrderId, 'cancelOrder');
    const row = await this.#rowAfterAck(symbol, clientOrderId, keys, 'cancelOrder');
    if (row) return row;
    // Cancel carries no qty. An absent row must not become a sized order.
    throw new VenueUnavailableError(
      VENUE.id,
      'malformed',
      `cancelOrder ack ${orderId}: order row is absent so size is not invented`,
    );
  }

  /** Realtime row, else the same order on `/v5/order/history`. Empty stays empty. */
  async #rowAfterAck(
    symbol: string,
    clientOrderId: string,
    keys: VenueCredentials,
    operation: string,
  ): Promise<VenueOrder | null> {
    const query = { category: 'spot', symbol: venueSymbolOf(symbol), orderLinkId: clientOrderId };
    const realtime = await this.#signed('GET', '/v5/order/realtime', query, keys, operation);
    const live = firstOrderRow(realtime, operation);
    if (live) return mapBybitSpotOrder(live, symbol, new Date(this.#clock()));
    const history = await this.#signed('GET', '/v5/order/history', query, keys, operation);
    const past = firstOrderRow(history, operation);
    if (past) return mapBybitSpotOrder(past, symbol, new Date(this.#clock()));
    return null;
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
