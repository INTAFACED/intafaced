import { describe, expect, it } from 'vitest';
import { BinanceSpotTrade } from './binance-spot.js';
import type { HttpPort, HttpResponse } from '../transport.js';

class FakeHttp implements HttpPort {
  readonly requests: string[] = [];
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

  async post(url: string): Promise<HttpResponse> {
    this.requests.push(`POST ${url}`);
    return this.#next(url);
  }

  async delete(url: string): Promise<HttpResponse> {
    this.requests.push(`DELETE ${url}`);
    return this.#next(url);
  }

  async #next(url: string): Promise<HttpResponse> {
    const next = this.#responses.shift();
    if (!next) throw new Error(`FakeHttp had no queued response for ${url}`);
    return next;
  }
}

const depthSnapshot = (lastUpdateId: number): unknown => ({
  lastUpdateId,
  bids: [
    ['30000.00', '2.00'],
    ['29999.00', '5.00'],
  ],
  asks: [
    ['30002.00', '1.00'],
    ['30003.00', '4.00'],
  ],
});

describe('BinanceSpotTrade placeOrder', () => {
  it('refuses a non-positive amount or limit price before any signed request', async () => {
    const keys = { venueId: 'binance-spot' as const, apiKey: 'k', apiSecret: 's', scopes: ['read', 'trade'] as const };
    const clock = () => 1_700_000_000_000;
    const options = { restBase: 'https://rest.test', clock, snapshotLimit: 5 as const };
    const positiveAmount = 1n;
    const positivePrice = 1n;
    const cases: ReadonlyArray<{
      readonly amount: bigint;
      readonly price?: bigint;
      readonly type: 'limit' | 'market';
      readonly message: RegExp;
    }> = [
      { type: 'limit', amount: 0n, price: positivePrice, message: /amount must be positive/ },
      { type: 'limit', amount: -1n, price: positivePrice, message: /amount must be positive/ },
      { type: 'market', amount: 0n, message: /amount must be positive/ },
      { type: 'market', amount: -1n * 10n ** 18n, message: /amount must be positive/ },
      { type: 'limit', amount: positiveAmount, price: 0n, message: /limit order price must be positive/ },
      { type: 'limit', amount: positiveAmount, price: -1n, message: /limit order price must be positive/ },
    ];
    const seen: FakeHttp[] = [];

    for (const [index, order] of cases.entries()) {
      const http = new FakeHttp().queue(depthSnapshot(1));
      seen.push(http);
      await expect(
        new BinanceSpotTrade(keys, { ...options, http }).placeOrder({
          symbol: 'BTC/USDT',
          side: 'buy',
          type: order.type,
          amount: order.amount,
          ...(order.price === undefined ? {} : { price: order.price }),
          clientOrderId: `np-${index}`,
        }),
      ).rejects.toMatchObject({ reason: 'malformed', message: expect.stringMatching(order.message) });
    }

    for (const http of seen) {
      expect(http.requests.some((url) => url.includes('/api/v3/order'))).toBe(false);
      expect(http.requests.some((url) => url.includes('signature='))).toBe(false);
      expect(http.requests.some((url) => url.includes('quantity='))).toBe(false);
    }
  });
});
