import { createHmac } from 'node:crypto';
import { formatAmount, SCALE, type Amount } from '@intafaced/ledger-client/money';
import {
  readDecimal,
  readInteger,
  parseUnifiedSymbol,
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

function unavailable(reason: VenueUnavailableReason, message: string, sent: boolean): never {
  throw new VenueUnavailableError(VENUE.id, reason, message, sent);
}

/** Taker fee as a fraction of notional. Null when the venue does not publish one rate. */
export function bybitTakerCommissionRate(body: unknown): Amount | null {
  if (!body || typeof body !== 'object') return null;
  const list = (body as { result?: { list?: unknown } }).result?.list;
  if (!Array.isArray(list) || list.length !== 1) return null;
  const row = list[0];
  if (!row || typeof row !== 'object') return null;
  const raw = (row as { takerFeeRate?: unknown }).takerFeeRate;
  if (raw === undefined || raw === null || raw === '') return null;
  try {
    const rate = readDecimal(raw, VENUE.id, 'takerFeeRate');
    if (rate < 0n || rate >= SCALE) return null;
    return rate;
  } catch {
    return null;
  }
}

/** Tick, step and min notional. A missing filter is unknown. */
export function bybitSymbolFilters(raw: Record<string, unknown>): {
  tickSize: Amount;
  stepSize: Amount;
  minNotional: Amount;
} | null {
  if (String(raw.status ?? '') !== 'Trading') return null;
  const lot = raw.lotSizeFilter;
  const price = raw.priceFilter;
  if (!lot || typeof lot !== 'object' || !price || typeof price !== 'object') return null;
  const lotRow = lot as Record<string, unknown>;
  const priceRow = price as Record<string, unknown>;
  try {
    const tickSize = readDecimal(priceRow.tickSize, VENUE.id, 'tickSize');
    const stepSize = readDecimal(lotRow.basePrecision, VENUE.id, 'basePrecision');
    const minNotional = readDecimal(lotRow.minOrderAmt, VENUE.id, 'minOrderAmt');
    if (tickSize <= 0n || stepSize <= 0n || minNotional < 0n) return null;
    return { tickSize, stepSize, minNotional };
  } catch {
    return null;
  }
}

function venueSymbolOf(unified: string): string {
  if (parseUnifiedSymbol(unified) === null) {
    unavailable('malformed', `symbol ${unified || '(empty)'} is not unified BASE/QUOTE spot`, false);
  }
  return unified.replace(/[/:]/g, '').toUpperCase();
}

/**
 * Bybit reports `cumExecFee` on the order row. Nothing filled is not a fee:
 * `feePaid` stays null so a zero is not invented. A missing fee on a fill stays
 * unknown (null) so the book refuses it. A single `cumFeeDetail` key names the
 * asset; more than one key leaves the asset unknown rather than summing them.
 */
function bybitReportedFee(row: Record<string, unknown>, executed: bigint): { feePaid: VenueOrder['feePaid']; feeAsset: string | null } {
  if (executed === 0n) return { feePaid: null, feeAsset: null };
  const raw = row.cumExecFee;
  if (raw === undefined || raw === null || raw === '') return { feePaid: null, feeAsset: null };
  const feePaid = readDecimal(raw, VENUE.id, 'cumExecFee');
  if (feePaid < 0n) unavailable('malformed', 'cumExecFee must not be negative', false);
  if (feePaid === 0n) return { feePaid: 0n, feeAsset: null };
  const detail = row.cumFeeDetail;
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const keys = Object.keys(detail as Record<string, unknown>);
    if (keys.length === 1 && keys[0]) return { feePaid, feeAsset: keys[0] };
  }
  return { feePaid, feeAsset: null };
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

export function mapBybitSpotOrder(row: Record<string, unknown>, unified: string, now: Date, sent = false): VenueOrder {
  const fail = (message: string): never => {
    unavailable('malformed', message, sent);
  };
  const statusRaw = String(row.orderStatus ?? '');
  const status = ORDER_STATUS[statusRaw];
  assertKnownOrderStatus(VENUE.id, status, statusRaw, 'order status', sent);
  const orig = readDecimal(row.qty, VENUE.id, 'qty');
  const executed = readDecimal(row.cumExecQty ?? '0', VENUE.id, 'cumExecQty');
  if (orig <= 0n) fail('qty must be positive');
  if (executed < 0n) fail('cumExecQty must not be negative');
  const remaining = orig - executed;
  if (remaining < 0n) fail('cumExecQty exceeds qty');
  const avgRaw = row.avgPrice;
  let averagePrice: VenueOrder['averagePrice'] = null;
  if (executed > 0n) {
    averagePrice = readDecimal(avgRaw, VENUE.id, 'avgPrice');
    if (averagePrice <= 0n) fail('avgPrice must be positive after a fill — outcome unknown, not a fill');
  }
  const typeRaw = String(row.orderType ?? '').toLowerCase();
  if (typeRaw !== 'market' && typeRaw !== 'limit') {
    unavailable('malformed', `orderType ${typeRaw || '(empty)'} is not a known Bybit spot type`, sent);
  }
  const type: VenueOrder['type'] = typeRaw;
  const price =
    type === 'market' || row.price === undefined || row.price === null || String(row.price) === '0'
      ? null
      : readDecimal(row.price, VENUE.id, 'price');
  if (type === 'limit' && (price === null || price <= 0n)) fail('limit order price must be positive');
  const createdRaw = row.createdTime ?? row.updatedTime;
  const createdAt = createdRaw === undefined || createdRaw === null ? now : new Date(readInteger(createdRaw, VENUE.id, 'createdTime'));
  const sideRaw = String(row.side ?? '').toLowerCase();
  if (sideRaw !== 'buy' && sideRaw !== 'sell') {
    unavailable('malformed', `side ${sideRaw || '(empty)'} is not a known Bybit side`, sent);
  }
  // cumExecQty is always base. Market qty may be quote value (Bybit's market-buy default), so
  // never derive remaining from it unless the unit is base; sells default to base when absent.
  const quantityUnit = row.marketUnit ?? '';
  if (typeRaw === 'market' && quantityUnit !== 'baseCoin' && !(sideRaw === 'sell' && quantityUnit === '')) {
    fail('spot market quantity unit must be baseCoin');
  }
  const venueOrderId = String(row.orderId ?? '').trim();
  const clientOrderId = String(row.orderLinkId ?? '').trim();
  if (!venueOrderId) fail('orderId is missing');
  if (!clientOrderId) fail('orderLinkId is missing');
  assertFillReportMatchesStatus(VENUE.id, status, executed, averagePrice, sent);
  const fee = bybitReportedFee(row, executed);
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
    feePaid: fee.feePaid,
    feeAsset: fee.feeAsset,
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
    if (request.clientOrderId.length > 36) unavailable('malformed', 'clientOrderId exceeds 36 characters', false);
    if (request.amount <= 0n) unavailable('malformed', 'order amount must be positive', false);
    if (!request.clientOrderId.trim()) unavailable('malformed', 'clientOrderId is required', false);
    if (request.type === 'limit' && request.price !== undefined && request.price !== null && request.price <= 0n) {
      unavailable('malformed', 'limit order price must be positive', false);
    }
    venueSymbolOf(request.symbol);
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
      payload.timeInForce = request.postOnly ? 'PostOnly' : (request.timeInForce ?? 'GTC');
    } else {
      // Unified amounts are base quantity; Bybit market buys default to quote value.
      payload.marketUnit = 'baseCoin';
    }
    await this.#signed('POST', '/v5/order/create', payload, keys, 'placeOrder', false);
    try {
      return await this.fetchOrder(request.symbol, request.clientOrderId);
    } catch (error) {
      try {
        if (error instanceof VenueUnavailableError && /realtime list is empty/i.test(error.message)) {
          const closed = await this.fetchClosedOrder(request.symbol, request.clientOrderId);
          if (closed) return closed;
        }
      } catch (closedError) {
        rethrowWithSent(closedError, true);
      }
      rethrowWithSent(error, true);
    }
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
      unavailable('unreachable', 'fetchOrder: realtime list is empty', false);
    }
    const row = list[0];
    if (!row || typeof row !== 'object') unavailable('malformed', 'fetchOrder row is not an object', false);
    return mapBybitSpotOrder(row as Record<string, unknown>, symbol, new Date(this.#clock()), false);
  }

  /**
   * Closed spot orders leave the realtime list. An empty history is a confirmed
   * miss (`null`). An empty realtime list is not — the caller has to ask here.
   * Without `window`, Bybit returns the last 7 days only. `startTime`/`endTime`
   * are the claim window, so an order older than that default is still found.
   */
  async fetchClosedOrder(symbol: string, clientOrderId: string, window?: ClosedOrderWindow): Promise<VenueOrder | null> {
    const keys = requireCredentials(VENUE.id, 'fetchClosedOrder', this.#credentials);
    const params: Record<string, string> = {
      category: 'spot',
      symbol: venueSymbolOf(symbol),
      orderLinkId: clientOrderId,
    };
    if (window) {
      if (window.endTimeMs < window.startTimeMs) {
        unavailable('unreachable', 'fetchClosedOrder has no claim window — outcome unknown, not a miss', false);
      }
      params.startTime = String(Math.trunc(window.startTimeMs));
      params.endTime = String(Math.trunc(window.endTimeMs));
    }
    const body = await this.#signed('GET', '/v5/order/history', params, keys, 'fetchClosedOrder');
    const list = (body.result as { list?: unknown })?.list;
    if (!Array.isArray(list) || list.length === 0) return null;
    const row = list[0];
    if (!row || typeof row !== 'object') {
      unavailable('malformed', 'fetchClosedOrder row is not an object', false);
    }
    return mapBybitSpotOrder(row as Record<string, unknown>, symbol, new Date(this.#clock()));
  }

  async openOrders(symbol?: string): Promise<VenueOrder[]> {
    const keys = requireCredentials(VENUE.id, 'openOrders', this.#credentials);
    if (!symbol) {
      unavailable('malformed', 'openOrders requires a symbol — Bybit spot has no all-markets list without settleCoin', false);
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
      unavailable('malformed', 'openOrders did not return a list', false);
    }
    const now = new Date(this.#clock());
    return list.map((row) => {
      if (!row || typeof row !== 'object') {
        unavailable('malformed', 'openOrders row is not an object', false);
      }
      return mapBybitSpotOrder(row as Record<string, unknown>, symbol, now);
    });
  }

  /** Taker fee fraction. Null when the account endpoint does not publish one rate. */
  async commissionRate(symbol: string): Promise<Amount | null> {
    const keys = requireCredentials(VENUE.id, 'commissionRate', this.#credentials);
    const body = await this.#signed(
      'GET',
      '/v5/account/fee-rate',
      { category: 'spot', symbol: venueSymbolOf(symbol) },
      keys,
      'commissionRate',
    );
    return bybitTakerCommissionRate(body);
  }

  /** Instrument filters. Null when the symbol is absent or a filter is missing. */
  async symbolFilters(symbol: string): Promise<{ tickSize: Amount; stepSize: Amount; minNotional: Amount } | null> {
    const native = venueSymbolOf(symbol);
    const url = `${this.#restBase}/v5/market/instruments-info?category=spot&symbol=${encodeURIComponent(native)}`;
    let response;
    try {
      response = await this.#http.get(url);
    } catch (error) {
      throwVenueTransportFailure(VENUE.id, 'GET', '/v5/market/instruments-info', error);
    }
    if (response.status < 200 || response.status >= 300 || response.body === null || typeof response.body !== 'object') {
      unavailable('unreachable', `instruments-info HTTP ${response.status}`, false);
    }
    const body = response.body as { retCode?: unknown; result?: { list?: unknown } };
    if (body.retCode !== 0) return null;
    const list = body.result?.list;
    if (!Array.isArray(list) || list.length === 0) return null;
    const match = list.find((row) => row && typeof row === 'object' && String((row as { symbol?: unknown }).symbol) === native);
    if (!match || typeof match !== 'object') return null;
    return bybitSymbolFilters(match as Record<string, unknown>);
  }

  /**
   * `sent` is true when a place POST was already dispatched. The place POST
   * itself flips to sent at the moment it is handed to the transport.
   */
  async #signed(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, string>,
    keys: VenueCredentials,
    operation: string,
    sent = false,
  ): Promise<Record<string, unknown>> {
    let dispatched = sent;
    const fail = (reason: VenueUnavailableReason, message: string): never => {
      unavailable(reason, message, dispatched);
    };
    const post = this.#http.post?.bind(this.#http);
    if (method === 'POST' && !post) fail('not_ready', `${operation}: HTTP POST port is not wired`);

    const now = this.#clock();
    const decision = this.#governor.tryAcquire(1, now);
    if (!decision.admitted) fail('rate_limited', `${decision.detail} (retry in ${decision.retryAfterMs}ms)`);

    if (operation === 'placeOrder') dispatched = true;
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
      throwVenueTransportFailure(VENUE.id, method, path, error, dispatched);
    }

    const accessTooFrequent =
      response.status === 403 ||
      (typeof response.body === 'object' &&
        response.body !== null &&
        /access too frequent/i.test(String((response.body as { retMsg?: unknown }).retMsg ?? '')));
    if (response.status === 429 || accessTooFrequent) {
      this.#governor.observeVenueBackoff(IP_BACKOFF_MS, `HTTP ${response.status}`, this.#clock());
      fail('rate_limited', `${VENUE.id} answered ${response.status}; backing off for ${IP_BACKOFF_MS}ms`);
    }

    if (response.status < 200 || response.status >= 300 || response.body === null || typeof response.body !== 'object') {
      fail('unreachable', `${operation} HTTP ${response.status}`);
    }

    const body = response.body as Record<string, unknown>;
    if (typeof body.retCode !== 'number') {
      unavailable('malformed', `${operation} answered with no numeric retCode`, dispatched);
    }
    if (RATE_LIMIT_RET_CODES.has(body.retCode)) {
      this.#governor.observeVenueBackoff(IP_BACKOFF_MS, `retCode ${body.retCode}`, this.#clock());
      fail('rate_limited', `${VENUE.id} answered retCode ${body.retCode} inside HTTP 200; backing off for ${IP_BACKOFF_MS}ms`);
    }
    if (body.retCode !== 0) {
      const retMsg = typeof body.retMsg === 'string' ? body.retMsg : '';
      fail('unreachable', `${operation} retCode ${body.retCode} (${retMsg})`);
    }
    return body;
  }
}
