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
import { fetchHttpPort, type HttpPort, type HttpRequestInit, type HttpResponse } from '../transport.js';
import { RateLimitGovernor } from '../rate-limit.js';
import { assertCredentialVenue } from './credential-guard.js';
import { assertFillReportMatchesStatus, assertKnownOrderStatus, throwVenueTransportFailure } from './order-outcome-honesty.js';
import { assertTradeBookPayoutGradeBeforePlace } from '../trade-payout-gate.js';

const REST_BASE = 'https://www.okx.com';
const RATE_LIMIT_CODES = new Set(['50011']);
const RATE_LIMIT = { venueId: 'okx-spot', capacity: 10, windowMs: 2_000 } as const;

function okxSymbolOf(unified: string): string {
  if (parseUnifiedSymbol(unified) === null) {
    throw new VenueUnavailableError(VENUE.id, 'malformed', `symbol ${unified || '(empty)'} is not unified BASE/QUOTE spot`);
  }
  return unified.replace(/:/g, '-').replace(/\//g, '-').toUpperCase();
}

function retryAfterFrom(header: string | null, fallbackMs = 60_000): number {
  if (!header) return fallbackMs;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return fallbackMs;
  return Math.ceil(seconds * 1_000);
}

const VENUE: VenueDescriptor = {
  id: 'okx-spot',
  displayName: 'OKX Spot',
  kind: 'external-cex',
  sequencedDepth: true,
};

const OKX_ORDER_STATE: Record<string, VenueOrder['status']> = {
  live: 'open',
  partially_filled: 'partially_filled',
  filled: 'filled',
  canceled: 'canceled',
};

export function signOkxRequest(secret: string, timestamp: string, method: string, requestPath: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}${method}${requestPath}${body}`).digest('base64');
}

export function mapOkxSpotOrder(row: Record<string, unknown>, unified: string, now: Date): VenueOrder {
  const stateRaw = String(row.state ?? '');
  const status = OKX_ORDER_STATE[stateRaw];
  assertKnownOrderStatus(VENUE.id, status, stateRaw, 'order state');
  const amount = readDecimal(row.sz, VENUE.id, 'sz');
  const filled = readDecimal(row.accFillSz, VENUE.id, 'accFillSz');
  if (amount <= 0n) throw new VenueUnavailableError(VENUE.id, 'malformed', 'sz must be positive');
  if (filled < 0n) throw new VenueUnavailableError(VENUE.id, 'malformed', 'accFillSz must not be negative');
  const typeRaw = String(row.ordType ?? '');
  const sideRaw = String(row.side ?? '').toLowerCase();
  const quantityUnit = row.tgtCcy ?? '';
  // accFillSz is always base. Market sz may be quote on either side; do not
  // derive a base amount/remaining from quote spend or an average execution price.
  if (typeRaw === 'market' && quantityUnit !== 'base_ccy' && !(sideRaw === 'sell' && quantityUnit === '')) {
    throw new VenueUnavailableError(VENUE.id, 'malformed', 'spot market quantity unit must be base_ccy before subtracting accFillSz');
  }
  const remaining = amount - filled;
  if (remaining < 0n) {
    throw new VenueUnavailableError(VENUE.id, 'malformed', 'accFillSz exceeds sz');
  }
  if (typeRaw !== 'market' && typeRaw !== 'limit' && typeRaw !== 'post_only') {
    throw new VenueUnavailableError(VENUE.id, 'malformed', `ordType ${typeRaw || '(empty)'} is not a known OKX spot type`);
  }
  const type: VenueOrder['type'] = typeRaw === 'market' ? 'market' : 'limit';
  const px = row.px;
  const price =
    type === 'market' || px === undefined || px === null || String(px) === '' || String(px) === '0'
      ? null
      : readDecimal(px, VENUE.id, 'px');
  if (type === 'limit' && (price === null || price <= 0n)) {
    throw new VenueUnavailableError(VENUE.id, 'malformed', 'limit order px must be positive');
  }
  let averagePrice: VenueOrder['averagePrice'] = null;
  const avgPx = row.avgPx;
  if (filled > 0n && avgPx !== undefined && avgPx !== null && String(avgPx) !== '' && String(avgPx) !== '0') {
    averagePrice = readDecimal(avgPx, VENUE.id, 'avgPx');
  }
  if (filled > 0n && (averagePrice === null || averagePrice <= 0n)) {
    throw new VenueUnavailableError(VENUE.id, 'malformed', 'avgPx must be positive after a fill — outcome unknown, not a fill');
  }
  const createdRaw = row.cTime ?? row.uTime;
  const createdAt = createdRaw === undefined || createdRaw === null ? now : new Date(readInteger(createdRaw, VENUE.id, 'cTime'));
  if (sideRaw !== 'buy' && sideRaw !== 'sell') {
    throw new VenueUnavailableError(VENUE.id, 'malformed', `side ${sideRaw || '(empty)'} is not a known OKX side`);
  }
  const venueOrderId = String(row.ordId ?? '').trim();
  const clientOrderId = String(row.clOrdId ?? '').trim();
  if (!venueOrderId || venueOrderId === '0') throw new VenueUnavailableError(VENUE.id, 'malformed', 'ordId is missing or invalid');
  if (!clientOrderId) throw new VenueUnavailableError(VENUE.id, 'malformed', 'clOrdId is missing');
  assertFillReportMatchesStatus(VENUE.id, status, filled, averagePrice);
  return {
    venueId: VENUE.id,
    venueOrderId,
    clientOrderId,
    symbol: unified,
    side: sideRaw,
    type,
    price,
    amount,
    filled,
    remaining,
    averagePrice,
    status,
    feePaid: null,
    feeAsset: null,
    createdAt,
    observedAt: now,
  };
}

function requirePassphrase(keys: VenueCredentials): string {
  const passphrase = keys.passphrase;
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new VenueUnavailableError(VENUE.id, 'not_ready', 'passphrase required');
  }
  return passphrase;
}

function firstDataRow(data: unknown, operation: string): Record<string, unknown> {
  if (!Array.isArray(data) || data.length === 0 || data[0] === null || typeof data[0] !== 'object') {
    throw new VenueUnavailableError(VENUE.id, 'malformed', `${operation} carried no order object`);
  }
  return data[0] as Record<string, unknown>;
}

function unifiedFromInstId(instId: string, fallback: string): string {
  const parts = instId.split('-');
  if (parts.length === 2 && parts[0] && parts[1]) return `${parts[0]}/${parts[1]}`;
  return fallback;
}

export interface OkxSpotTradeOptions {
  readonly http?: HttpPort;
  readonly restBase?: string;
  readonly clock?: () => number;
  readonly governor?: RateLimitGovernor;
  /** Depth for the payout-grade snapshot. Unset refuses — never invent 100. */
  readonly snapshotLimit?: number;
}

export class OkxSpotTrade implements TradeAdapter {
  readonly venue = VENUE;
  readonly #credentials: VenueCredentials | null;
  readonly #http: HttpPort;
  readonly #restBase: string;
  readonly #clock: () => number;
  readonly #governor: RateLimitGovernor;
  readonly #snapshotLimit: number | undefined;

  constructor(credentials: VenueCredentials | null = null, options: OkxSpotTradeOptions = {}) {
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
    if (request.type === 'market' && request.postOnly) {
      throw new VenueUnavailableError(VENUE.id, 'malformed', 'post-only is a limit-order instruction; a market order cannot be post-only');
    }
    okxSymbolOf(request.symbol);
    requirePassphrase(keys);
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
      instId: okxSymbolOf(request.symbol),
      tdMode: 'cash',
      clOrdId: request.clientOrderId,
      side: request.side,
      ordType: request.type === 'market' ? 'market' : request.postOnly ? 'post_only' : 'limit',
      sz: formatAmount(request.amount),
    };
    // Unified amounts are base quantity on both sides; make the market unit explicit.
    if (request.type === 'market') payload.tgtCcy = 'base_ccy';
    if (request.type === 'limit') payload.px = formatAmount(request.price!);
    const ack = await this.#signed('POST', '/api/v5/trade/order', keys, 'placeOrder', payload);
    const row = firstDataRow(ack.data, 'placeOrder');
    this.#assertAck(row, 'placeOrder');
    return this.fetchOrder(request.symbol, request.clientOrderId);
  }

  async cancelOrder(symbol: string, clientOrderId: string): Promise<VenueOrder> {
    const keys = requireCredentials(VENUE.id, 'cancelOrder', this.#credentials);
    requirePassphrase(keys);
    const ack = await this.#signed('POST', '/api/v5/trade/cancel-order', keys, 'cancelOrder', {
      instId: okxSymbolOf(symbol),
      clOrdId: clientOrderId,
    });
    this.#assertAck(firstDataRow(ack.data, 'cancelOrder'), 'cancelOrder');
    return this.fetchOrder(symbol, clientOrderId);
  }

  async fetchOrder(symbol: string, clientOrderId: string): Promise<VenueOrder> {
    const keys = requireCredentials(VENUE.id, 'fetchOrder', this.#credentials);
    requirePassphrase(keys);
    const path = `/api/v5/trade/order?instId=${encodeURIComponent(okxSymbolOf(symbol))}&clOrdId=${encodeURIComponent(clientOrderId)}`;
    const body = await this.#signed('GET', path, keys, 'fetchOrder');
    return mapOkxSpotOrder(firstDataRow(body.data, 'fetchOrder'), symbol, new Date(this.#clock()));
  }

  async openOrders(symbol?: string): Promise<VenueOrder[]> {
    const keys = requireCredentials(VENUE.id, 'openOrders', this.#credentials);
    requirePassphrase(keys);
    const path = symbol
      ? `/api/v5/trade/orders-pending?instType=SPOT&instId=${encodeURIComponent(okxSymbolOf(symbol))}`
      : '/api/v5/trade/orders-pending?instType=SPOT';
    const body = await this.#signed('GET', path, keys, 'openOrders');
    if (!Array.isArray(body.data)) {
      throw new VenueUnavailableError(VENUE.id, 'malformed', 'openOrders did not return a data array');
    }
    const now = new Date(this.#clock());
    return body.data.map((row) => {
      if (!row || typeof row !== 'object') {
        throw new VenueUnavailableError(VENUE.id, 'malformed', 'openOrders row is not an object');
      }
      const rec = row as Record<string, unknown>;
      const unified = symbol ?? unifiedFromInstId(String(rec.instId ?? ''), '');
      if (parseUnifiedSymbol(unified) === null) {
        throw new VenueUnavailableError(VENUE.id, 'malformed', 'openOrders row carried an invalid spot instId');
      }
      return mapOkxSpotOrder(rec, unified, now);
    });
  }

  #assertAck(row: Record<string, unknown>, operation: string): void {
    if (row.sCode === undefined || row.sCode === null) return;
    if (String(row.sCode) === '0') return;
    const msg = typeof row.sMsg === 'string' ? row.sMsg : '';
    throw new VenueUnavailableError(
      VENUE.id,
      'not_ready',
      `${operation} refused: sCode ${String(row.sCode)} (${msg || 'no message'}) — the venue declined this request. ` +
        'This call is refused rather than simulated — a fabricated order status is worse than an outage.',
    );
  }

  async #signed(
    method: 'GET' | 'POST',
    requestPath: string,
    keys: VenueCredentials,
    operation: string,
    jsonBody?: Record<string, string>,
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

    const passphrase = requirePassphrase(keys);
    const timestamp = new Date(now).toISOString();
    const body = jsonBody === undefined ? '' : JSON.stringify(jsonBody);
    const sign = signOkxRequest(keys.apiSecret, timestamp, method, requestPath, body);
    const headers: Record<string, string> = {
      'OK-ACCESS-KEY': keys.apiKey,
      'OK-ACCESS-SIGN': sign,
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': passphrase,
    };
    if (method === 'POST') headers['Content-Type'] = 'application/json';

    const init: HttpRequestInit = method === 'POST' ? { headers, jsonBody } : { headers };
    const url = `${this.#restBase}${requestPath}`;
    let response: HttpResponse;
    try {
      response = method === 'GET' ? await this.#http.get(url, init) : await post!(url, init);
    } catch (error) {
      throwVenueTransportFailure(VENUE.id, method, requestPath, error);
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
      throw new VenueUnavailableError(VENUE.id, 'unreachable', `${operation} answered ${response.status}`);
    }

    const envelope = response.body as Record<string, unknown>;
    if (envelope.code !== '0') {
      const code = envelope.code === undefined || envelope.code === null ? '' : String(envelope.code);
      const msg = typeof envelope.msg === 'string' ? envelope.msg : '';
      if (RATE_LIMIT_CODES.has(code)) {
        const retryAfterMs = retryAfterFrom(response.header('Retry-After'));
        this.#governor.observeVenueBackoff(retryAfterMs, `code ${code}`, this.#clock());
        throw new VenueUnavailableError(
          VENUE.id,
          'rate_limited',
          `${VENUE.id} answered code ${code} (${msg}) inside an HTTP 200; backing off for ${retryAfterMs}ms`,
        );
      }
      throw new VenueUnavailableError(
        VENUE.id,
        'not_ready',
        `${operation} refused: code ${code || '(missing)'} (${msg || 'no message'}) — the venue declined this request. ` +
          'This call is refused rather than simulated — a fabricated order status is worse than an outage.',
      );
    }

    return envelope;
  }
}
