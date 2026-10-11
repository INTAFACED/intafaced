import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import { VenueUnavailableError, type VenueOrder } from '@intafaced/venue-contracts';
import { BybitSpotTrade } from './bybit-spot-trade.js';
import type { HttpPort, HttpResponse } from '../transport.js';

class FakeHttp implements HttpPort {
  readonly requests: string[] = [];
  readonly posts: { url: string; jsonBody?: unknown }[] = [];
  #responses: HttpResponse[] = [];

  queue(body: unknown, status = 200, headers: Record<string, string> = {}): this {
    this.#responses.push({
      status,
      body,
      header: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null,
    });
    return this;
  }

  async get(url: string): Promise<HttpResponse> {
    this.requests.push(url);
    return this.#next(url);
  }

  async post(url: string, init?: { jsonBody?: unknown }): Promise<HttpResponse> {
    this.requests.push(`POST ${url}`);
    this.posts.push({ url, jsonBody: init?.jsonBody });
    return this.#next(url);
  }

  async #next(url: string): Promise<HttpResponse> {
    const next = this.#responses.shift();
    if (!next) throw new Error(`FakeHttp had no queued response for ${url}`);
    return next;
  }
}

const CLOCK = 1_700_000_000_000;

const LEVELS = {
  b: [
    ['30000.00', '2.00'],
    ['29999.00', '5.00'],
  ] as [string, string][],
  a: [
    ['30002.00', '1.00'],
    ['30003.00', '4.00'],
  ] as [string, string][],
};

/** Thick book. Best-level notional clears the fixture floor of 250. */
const orderbook = (): unknown => ({
  retCode: 0,
  retMsg: 'OK',
  result: {
    s: 'BTCUSDT',
    b: LEVELS.b,
    a: LEVELS.a,
    ts: CLOCK,
    u: 1,
    seq: 9_001,
    cts: CLOCK,
  },
  retExtInfo: {},
  time: CLOCK,
});

const keys = { venueId: 'bybit-spot', apiKey: 'k', apiSecret: 's', scopes: ['read', 'trade'] as const };

function tradeFor(http: FakeHttp): BybitSpotTrade {
  return new BybitSpotTrade(keys, {
    http,
    clock: () => CLOCK,
    snapshotLimit: 5,
    payoutPolicy: { minBestLevelNotional: '250' },
  });
}

const listBody = (list: unknown[]) => ({ retCode: 0, retMsg: 'OK', result: { list } });

const ackBody = (orderId: string, orderLinkId: string) => ({
  retCode: 0,
  retMsg: 'OK',
  result: { orderId, orderLinkId },
});

function orderRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderId: 'row-1',
    orderLinkId: 'cli-1',
    symbol: 'BTCUSDT',
    side: 'Buy',
    orderType: 'Limit',
    price: '30000',
    qty: '1',
    cumExecQty: '0',
    avgPrice: '0',
    orderStatus: 'New',
    createdTime: String(CLOCK),
    ...over,
  };
}

function limitRequest(clientOrderId: string) {
  return {
    symbol: 'BTC/USDT',
    side: 'buy' as const,
    type: 'limit' as const,
    amount: parseAmount('1'),
    price: parseAmount('30000'),
    clientOrderId,
  };
}

describe('Bybit place and cancel when the realtime list is empty', () => {
  it('returns the accepted open order when create ack is good and both lists are empty', async () => {
    const clientOrderId = 'cli-empty';
    const orderId = 'ack-live-1';
    const http = new FakeHttp().queue(orderbook()).queue(ackBody(orderId, clientOrderId)).queue(listBody([])).queue(listBody([]));
    const request = limitRequest(clientOrderId);
    const placed = await tradeFor(http).placeOrder(request);
    expect(placed).toMatchObject({
      venueId: 'bybit-spot',
      venueOrderId: orderId,
      clientOrderId,
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      price: request.price,
      amount: request.amount,
      filled: 0n,
      remaining: request.amount,
      averagePrice: null,
      status: 'open',
      feePaid: null,
      feeAsset: null,
      createdAt: new Date(CLOCK),
      observedAt: new Date(CLOCK),
    } satisfies Partial<VenueOrder>);
    expect(http.requests.some((url) => url.includes('/v5/order/realtime') && url.includes(`orderLinkId=${clientOrderId}`))).toBe(true);
    expect(http.requests.some((url) => url.includes('/v5/order/history') && url.includes(`orderLinkId=${clientOrderId}`))).toBe(true);
    expect(http.requests.some((url) => url.includes('/v5/market/orderbook'))).toBe(true);
  });

  it('returns a market ack as open with a null price when both lists are empty', async () => {
    const clientOrderId = 'mkt-empty';
    const orderId = 'ack-mkt-1';
    const amount = parseAmount('0.02');
    const http = new FakeHttp().queue(orderbook()).queue(ackBody(orderId, clientOrderId)).queue(listBody([])).queue(listBody([]));
    const placed = await tradeFor(http).placeOrder({
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'market',
      amount,
      clientOrderId,
    });
    expect(placed.status).toBe('open');
    expect(placed.filled).toBe(0n);
    expect(placed.remaining).toBe(amount);
    expect(placed.price).toBeNull();
    expect(placed.averagePrice).toBeNull();
    expect(placed.venueOrderId).toBe(orderId);
    expect(placed.clientOrderId).toBe(clientOrderId);
  });

  it('maps the realtime row, including cumExecQty, when the create ack is good', async () => {
    const clientOrderId = 'cli-live';
    const http = new FakeHttp()
      .queue(orderbook())
      .queue(ackBody('ack-live-2', clientOrderId))
      .queue(
        listBody([
          orderRow({
            orderId: 'rt-9',
            orderLinkId: clientOrderId,
            cumExecQty: '0.4',
            avgPrice: '30010',
            orderStatus: 'PartiallyFilled',
          }),
        ]),
      );
    const placed = await tradeFor(http).placeOrder(limitRequest(clientOrderId));
    expect(placed.venueOrderId).toBe('rt-9');
    expect(placed.status).toBe('partially_filled');
    expect(placed.filled).toBe(parseAmount('0.4'));
    expect(placed.averagePrice).toBe(parseAmount('30010'));
    expect(http.requests.some((url) => url.includes('/v5/order/history'))).toBe(false);
  });

  it('maps a filled history row instead of an open zero fill when realtime is empty', async () => {
    const clientOrderId = 'cli-hist';
    const http = new FakeHttp()
      .queue(orderbook())
      .queue(ackBody('ack-hist-1', clientOrderId))
      .queue(listBody([]))
      .queue(
        listBody([
          orderRow({
            orderId: 'hist-9',
            orderLinkId: clientOrderId,
            qty: '0.5',
            cumExecQty: '0.5',
            avgPrice: '30020.5',
            orderStatus: 'Filled',
          }),
        ]),
      );
    const placed = await tradeFor(http).placeOrder(limitRequest(clientOrderId));
    expect(placed.venueOrderId).toBe('hist-9');
    expect(placed.status).toBe('filled');
    expect(placed.filled).toBe(parseAmount('0.5'));
    expect(placed.filled).not.toBe(0n);
    expect(placed.averagePrice).toBe(parseAmount('30020.5'));
    expect(placed.status).not.toBe('open');
  });

  it('maps a cancelled history row when the cancel ack is good and realtime is empty', async () => {
    const clientOrderId = 'cli-cancel';
    const http = new FakeHttp()
      .queue(ackBody('ack-cancel-1', clientOrderId))
      .queue(listBody([]))
      .queue(
        listBody([
          orderRow({
            orderId: 'cx-9',
            orderLinkId: clientOrderId,
            side: 'Sell',
            orderStatus: 'Cancelled',
          }),
        ]),
      );
    const canceled = await tradeFor(http).cancelOrder('BTC/USDT', clientOrderId);
    expect(canceled.venueOrderId).toBe('cx-9');
    expect(canceled.status).toBe('canceled');
    expect(canceled.clientOrderId).toBe(clientOrderId);
    expect(http.requests.some((url) => url.includes('/v5/order/history'))).toBe(true);
  });

  it('refuses an empty cancel as malformed and does not invent a size', async () => {
    const clientOrderId = 'cli-cancel-empty';
    const orderId = 'ack-cancel-missing';
    const http = new FakeHttp().queue(ackBody(orderId, clientOrderId)).queue(listBody([])).queue(listBody([]));
    try {
      const returned = await tradeFor(http).cancelOrder('BTC/USDT', clientOrderId);
      expect.unreachable(`cancel returned ${returned.status} ${returned.venueOrderId}`);
    } catch (error) {
      expect(error).toBeInstanceOf(VenueUnavailableError);
      const refused = error as VenueUnavailableError;
      expect(refused.reason).toBe('malformed');
      expect(refused.reason).not.toBe('unreachable');
      expect(refused.message).toContain(orderId);
      expect(refused.message).toMatch(/order row is absent/);
      expect(refused.message).toMatch(/size is not invented/);
    }
  });

  it('refuses a create body with no orderId as malformed and does not read realtime', async () => {
    const clientOrderId = 'cli-no-id';
    const http = new FakeHttp().queue(orderbook()).queue({
      retCode: 0,
      retMsg: 'OK',
      result: { orderLinkId: clientOrderId },
    });
    try {
      const returned = await tradeFor(http).placeOrder(limitRequest(clientOrderId));
      expect.unreachable(`place returned ${returned.status} filled=${returned.filled}`);
    } catch (error) {
      expect(error).toBeInstanceOf(VenueUnavailableError);
      const refused = error as VenueUnavailableError;
      expect(refused.reason).toBe('malformed');
      expect(refused.reason).not.toBe('unreachable');
      expect(refused.message).not.toMatch(/realtime list is empty/);
    }
    expect(http.requests.some((url) => url.includes('/v5/order/realtime') || url.includes('/v5/order/history'))).toBe(false);
  });

  it('still throws unreachable from fetchOrder when the realtime list is empty', async () => {
    const http = new FakeHttp().queue(listBody([]));
    await expect(tradeFor(http).fetchOrder('BTC/USDT', 'cli-fetch')).rejects.toMatchObject({
      reason: 'unreachable',
      message: expect.stringMatching(/realtime list is empty/),
    });
  });

  it('refuses a non-object realtime row as malformed', async () => {
    const clientOrderId = 'cli-bad-row';
    const http = new FakeHttp().queue(orderbook()).queue(ackBody('ack-bad-row', clientOrderId)).queue(listBody([null]));
    await expect(tradeFor(http).placeOrder(limitRequest(clientOrderId))).rejects.toMatchObject({
      reason: 'malformed',
      message: expect.stringMatching(/row is not an object/),
    });
    expect(http.requests.some((url) => url.includes('/v5/order/history'))).toBe(false);
  });
});
