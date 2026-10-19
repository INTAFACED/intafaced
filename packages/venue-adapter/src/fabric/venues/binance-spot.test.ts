import { describe, expect, it } from 'vitest';
import { formatAmount } from '@intafaced/ledger-client/money';
import { VenueCredentialScopeError, VenueCredentialsMissingError, VenueUnavailableError } from '@intafaced/venue-contracts';
import {
  BinanceSpotAccount,
  BinanceSpotMarketData,
  BinanceSpotTrade,
  mapBinanceSpotOrder,
  retryAfterFrom,
  venueSymbolOf,
} from './binance-spot.js';
import { binanceSymbolFilters, binanceTakerSellCommissionRate, sumBinanceFillCommission } from './binance-spot-trade.js';
import { AsyncFrameQueue, type HttpPort, type HttpResponse, type StreamHandle, type StreamPort } from '../transport.js';
import { MaintainedBook } from '../book-feed.js';
import { RateLimitGovernor } from '../rate-limit.js';

// ════════════════════════════════════════════════════════════════════════════
// FAKE TRANSPORT
//
// The cases worth testing are the ones a healthy venue never produces on
// demand: a dropped depth update, a 429 with a Retry-After, a REST snapshot
// lagging its own websocket. You cannot ask the real venue for any of them.
// ════════════════════════════════════════════════════════════════════════════

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

class FakeStream implements StreamPort {
  readonly opened: string[] = [];
  readonly queues: AsyncFrameQueue<unknown>[] = [];
  closed = 0;

  async open(url: string): Promise<StreamHandle> {
    this.opened.push(url);
    const queue = new AsyncFrameQueue<unknown>();
    this.queues.push(queue);
    return {
      messages: queue,
      close: async () => {
        this.closed += 1;
        queue.close();
      },
    };
  }

  /** The socket for the Nth `open` call. */
  socket(index = 0): AsyncFrameQueue<unknown> {
    return this.queues[index]!;
  }
}

const depthEvent = (U: number, u: number, levels: { b?: [string, string][]; a?: [string, string][] } = {}): unknown => ({
  e: 'depthUpdate',
  E: 1,
  s: 'BTCUSDT',
  U,
  u,
  b: levels.b ?? [],
  a: levels.a ?? [],
});

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

function adapter(http: FakeHttp, stream: FakeStream, clock: () => number = () => 1_000_000) {
  return new BinanceSpotMarketData({
    http,
    stream,
    clock,
    restBase: 'https://rest.test',
    wsBase: 'wss://ws.test',
  });
}

// ════════════════════════════════════════════════════════════════════════════

describe('symbol mapping', () => {
  it('speaks the venue spelling only when talking to the venue', () => {
    expect(venueSymbolOf('BTC/USDT')).toBe('BTCUSDT');
    expect(venueSymbolOf('BTC/USD:BTC')).toBe('BTCUSDBTC');
  });
});

describe('BinanceSpotMarketData — public data, no credentials', () => {
  it('normalises markets, with the tick as a SIZE and fees marked indicative', async () => {
    const http = new FakeHttp().queue({
      symbols: [
        {
          symbol: 'BTCUSDT',
          status: 'TRADING',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          filters: [
            { filterType: 'PRICE_FILTER', tickSize: '0.01' },
            { filterType: 'LOT_SIZE', stepSize: '0.00001', minQty: '0.00001', maxQty: '9000' },
            { filterType: 'NOTIONAL', minNotional: '5' },
          ],
        },
        {
          symbol: 'DEADUSDT',
          status: 'BREAK',
          baseAsset: 'DEAD',
          quoteAsset: 'USDT',
          filters: [
            { filterType: 'PRICE_FILTER', tickSize: '0.01' },
            { filterType: 'LOT_SIZE', stepSize: '0.00001', minQty: '0.00001', maxQty: '9000' },
            { filterType: 'NOTIONAL', minNotional: '5' },
          ],
        },
      ],
    });

    const markets = await adapter(http, new FakeStream()).markets();

    expect(markets).toHaveLength(2);
    const btc = markets[0]!;
    expect(btc.symbol).toBe('BTC/USDT');
    expect(btc.venueSymbol).toBe('BTCUSDT');
    expect(btc.active).toBe(true);
    expect(formatAmount(btc.precision.price)).toBe('0.01');
    expect(formatAmount(btc.limits.minCost)).toBe('5');
    // Published defaults, not this account's rates — the flag travels with them.
    expect(btc.fees).toEqual({ makerBps: 10, takerBps: 10, indicative: true });

    // A halted market is marked inactive rather than dropped, so a caller can
    // say WHY there is no liquidity instead of showing an empty list.
    expect(markets[1]!.active).toBe(false);
  });

  it('refuses a symbol missing PRICE_FILTER, LOT_SIZE, or NOTIONAL/MIN_NOTIONAL instead of inventing a tick or a zero minimum', async () => {
    const trading = (symbol: string, base: string, filters: Record<string, unknown>[]): Record<string, unknown> => ({
      symbol,
      status: 'TRADING',
      baseAsset: base,
      quoteAsset: 'USDT',
      filters,
    });
    const price = (tickSize: string) => ({ filterType: 'PRICE_FILTER', tickSize });
    const lot = (stepSize: string, minQty: string) => ({
      filterType: 'LOT_SIZE',
      stepSize,
      minQty,
      maxQty: '9000',
    });
    const notional = (minNotional: string, filterType: 'NOTIONAL' | 'MIN_NOTIONAL' = 'NOTIONAL') => ({
      filterType,
      minNotional,
    });

    const http = new FakeHttp().queue({
      symbols: [
        trading('BTCUSDT', 'BTC', [price('0.01'), lot('0.00001', '0.00001'), notional('5')]),
        trading('ETHUSDT', 'ETH', [lot('0.0001', '0.0001'), notional('5')]),
        trading('SOLUSDT', 'SOL', [price('0.01'), notional('5')]),
        trading('XRPUSDT', 'XRP', [price('0.0001'), lot('0.1', '0.1')]),
        trading('ADAUSDT', 'ADA', [price('0.0001'), lot('0.1', '1'), notional('10', 'MIN_NOTIONAL')]),
      ],
    });

    const markets = await adapter(http, new FakeStream()).markets();
    const symbols = markets.map((market) => market.symbol);

    expect(symbols).toEqual(['BTC/USDT', 'ADA/USDT']);

    const btc = markets[0]!;
    expect(btc.active).toBe(true);
    expect(formatAmount(btc.precision.price)).toBe('0.01');
    expect(formatAmount(btc.precision.amount)).toBe('0.00001');
    expect(formatAmount(btc.limits.minAmount)).toBe('0.00001');
    expect(formatAmount(btc.limits.minCost)).toBe('5');

    const ada = markets[1]!;
    expect(ada.active).toBe(true);
    expect(formatAmount(ada.precision.price)).toBe('0.0001');
    expect(formatAmount(ada.precision.amount)).toBe('0.1');
    expect(formatAmount(ada.limits.minAmount)).toBe('1');
    expect(formatAmount(ada.limits.minCost)).toBe('10');

    for (const market of markets) {
      expect(formatAmount(market.precision.price)).not.toBe('0.00000001');
      expect(formatAmount(market.precision.amount)).not.toBe('0.00000001');
      expect(market.limits.minAmount).not.toBe(0n);
      expect(market.limits.minCost).not.toBe(0n);
    }

    const blank = new FakeHttp().queue({
      symbols: [trading('ETHUSDT', 'ETH', [lot('0.0001', '0.0001'), notional('5')])],
    });
    try {
      await adapter(blank, new FakeStream()).markets();
      expect.unreachable('a TRADING symbol missing PRICE_FILTER must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(VenueUnavailableError);
      expect((error as VenueUnavailableError).venueId).toBe('binance-spot');
      expect((error as VenueUnavailableError).reason).toBe('malformed');
    }
  });

  it('reads a snapshot with our clock, not the venue’s', async () => {
    const http = new FakeHttp().queue(depthSnapshot(4_242));
    const snapshot = await adapter(http, new FakeStream(), () => 1_700_000_000_000).snapshotBook('BTC/USDT', 100);

    expect(snapshot.sequence).toBe(4_242);
    expect(snapshot.sequenced).toBe(true);
    expect(snapshot.observedAt.getTime()).toBe(1_700_000_000_000);
    expect(formatAmount(snapshot.bids[0]![0])).toBe('30000');
    expect(http.requests[0]).toBe('https://rest.test/api/v3/depth?symbol=BTCUSDT&limit=100');
  });

  it('caps the depth limit rather than spending weight on a request the venue will reject', async () => {
    const http = new FakeHttp().queue(depthSnapshot(1));
    await adapter(http, new FakeStream()).snapshotBook('BTC/USDT', 999_999);
    expect(http.requests[0]).toContain('limit=5000');
  });

  it('opens the depth stream WS-first, at the venue’s 100ms cadence', async () => {
    const stream = new FakeStream();
    const md = adapter(new FakeHttp(), stream);
    const subscription = await md.streamBook('BTC/USDT');
    expect(stream.opened[0]).toBe('wss://ws.test/btcusdt@depth@100ms');
    await subscription.close();
  });

  it('carries the venue’s sequence RANGE, so a batched frame is not read as a gap', async () => {
    const stream = new FakeStream();
    const subscription = await adapter(new FakeHttp(), stream).streamBook('BTC/USDT');

    stream.socket().push(depthEvent(101, 107, { b: [['30001.00', '3.00']] }));
    stream.socket().close();

    const deltas = [];
    for await (const delta of subscription.deltas) deltas.push(delta);

    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.sequence).toEqual({ firstSequence: 101, lastSequence: 107 });
    expect(deltas[0]!.bids).toEqual([['30001', '3']]);
  });

  it('preserves a zero quantity in a delta — it is the only encoding of removal', async () => {
    const stream = new FakeStream();
    const subscription = await adapter(new FakeHttp(), stream).streamBook('BTC/USDT');
    stream.socket().push(depthEvent(101, 101, { b: [['30000.00', '0.00']] }));
    stream.socket().close();

    const deltas = [];
    for await (const delta of subscription.deltas) deltas.push(delta);
    expect(deltas[0]!.bids).toEqual([['30000', '0']]);
  });

  it('reads the trade tape and gets the AGGRESSOR the right way round', async () => {
    const stream = new FakeStream();
    const subscription = await adapter(new FakeHttp(), stream).streamTrades('BTC/USDT');
    expect(stream.opened[0]).toBe('wss://ws.test/btcusdt@trade');

    // `m: true` means the BUYER was the maker, so the taker was the seller.
    stream.socket().push({ e: 'trade', t: 77, p: '30001.50', q: '0.25', T: 1_700_000_000_000, m: true });
    stream.socket().push({ e: 'trade', t: 78, p: '30002.00', q: '0.10', T: 1_700_000_000_001, m: false });
    stream.socket().close();

    const trades = [];
    for await (const trade of subscription.trades) trades.push(trade);

    expect(trades.map((t) => t.takerSide)).toEqual(['sell', 'buy']);
    expect(formatAmount(trades[0]!.price)).toBe('30001.5');
    expect(trades[0]!.tradeId).toBe('77');
  });

  it('REFUSES a payload that has started arriving as JSON numbers', async () => {
    const http = new FakeHttp().queue({ lastUpdateId: 1, bids: [[30000, 2]], asks: [] });
    await expect(adapter(http, new FakeStream()).snapshotBook('BTC/USDT', 100)).rejects.toThrow(/JSON number/);
  });

  it('REFUSES a two-sided dust book as no_depth (D26-P1-T8 payout-grade)', async () => {
    const http = new FakeHttp().queue({
      lastUpdateId: 9,
      bids: [['30000.00', '0.00000001']],
      asks: [['30002.00', '0.00000001']],
    });
    const md = adapter(http, new FakeStream());
    try {
      await md.snapshotBook('BTC/USDT', 100);
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(VenueUnavailableError);
      expect((error as VenueUnavailableError).reason).toBe('no_depth');
      expect((error as VenueUnavailableError).message).toMatch(/not payout-grade/);
    }
  });
});

describe('rate governing on the REST path', () => {
  it('spends weight per endpoint, not per request', async () => {
    const governor = new RateLimitGovernor({ venueId: 'binance-spot', capacity: 60, windowMs: 60_000, reservedHeadroomBps: 0 }, 0);
    const http = new FakeHttp().queue(depthSnapshot(1)).queue(depthSnapshot(2));
    const md = new BinanceSpotMarketData({ http, stream: new FakeStream(), governor, clock: () => 0, restBase: 'https://rest.test' });

    // limit 1000 costs 50 weight. One fits in a 60-weight bucket; two do not.
    await md.snapshotBook('BTC/USDT', 1_000);
    await expect(md.snapshotBook('BTC/USDT', 1_000)).rejects.toThrow(VenueUnavailableError);
    await expect(md.snapshotBook('BTC/USDT', 1_000)).rejects.toThrow(/retry in/);
  });

  it('excludes and REPORTS the venue as rate_limited rather than waiting silently', async () => {
    const governor = new RateLimitGovernor({ venueId: 'binance-spot', capacity: 1, windowMs: 60_000, reservedHeadroomBps: 0 }, 0);
    const md = new BinanceSpotMarketData({ http: new FakeHttp(), stream: new FakeStream(), governor, clock: () => 0 });

    try {
      await md.snapshotBook('BTC/USDT', 1);
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(VenueUnavailableError);
      // The vocabulary matters: `rate_limited` is OUR constraint, not the
      // venue being down, and they need different responses on call.
      expect((error as VenueUnavailableError).reason).toBe('rate_limited');
    }
  });

  it('believes a 429 over its own arithmetic, and holds off for the venue’s Retry-After', async () => {
    let now = 0;
    const http = new FakeHttp().queue(null, 429, { 'Retry-After': '30' }).queue(depthSnapshot(1));
    const md = new BinanceSpotMarketData({ http, stream: new FakeStream(), clock: () => now, restBase: 'https://rest.test' });

    await expect(md.snapshotBook('BTC/USDT', 1)).rejects.toThrow(/answered 429/);

    // Plenty of weight left by our count. The venue said stop, so we stop.
    now = 1_000;
    await expect(md.snapshotBook('BTC/USDT', 1)).rejects.toThrow(/told us to back off/);
    expect(md.governor.backoffUntil(now)).toBe(30_000);

    // Only one request actually reached the transport.
    expect(http.requests).toHaveLength(1);
  });

  it('backs off on a 418 ban too', async () => {
    const http = new FakeHttp().queue(null, 418, {});
    const md = new BinanceSpotMarketData({ http, stream: new FakeStream(), clock: () => 0 });
    await expect(md.snapshotBook('BTC/USDT', 1)).rejects.toThrow(/answered 418/);
    // No parseable header — we still hold off, on the fallback, rather than
    // expiring the backoff instantly and walking back into the ban.
    expect(md.governor.backoffUntil(0)).toBe(60_000);
  });

  describe('retryAfterFrom', () => {
    it('floors an absent or unparseable header instead of reading it as zero', () => {
      expect(retryAfterFrom(null)).toBe(60_000);
      expect(retryAfterFrom('soon')).toBe(60_000);
      expect(retryAfterFrom('0')).toBe(60_000);
      expect(retryAfterFrom('-5')).toBe(60_000);
    });

    it('reads seconds and returns ms', () => {
      expect(retryAfterFrom('30')).toBe(30_000);
    });
  });
});

describe('latency grading on the live path', () => {
  it('records a successful read', async () => {
    let now = 0;
    const http = new FakeHttp().queue(depthSnapshot(1));
    const md = new BinanceSpotMarketData({
      http: {
        get: async (url) => {
          now += 42;
          return http.get(url);
        },
      },
      stream: new FakeStream(),
      clock: () => now,
    });

    await md.snapshotBook('BTC/USDT', 1);
    const grade = md.grader.grade(new Date(now));
    expect(grade.samples).toBe(1);
    expect(grade.p95Ms).toBe(42);
    // One sample is not a grade. It says so.
    expect(grade.provisional).toBe(true);
  });

  it('records a 429 as a REJECT, not as a success', async () => {
    const http = new FakeHttp().queue(null, 429, { 'Retry-After': '1' });
    const md = new BinanceSpotMarketData({ http, stream: new FakeStream(), clock: () => 0 });
    await expect(md.snapshotBook('BTC/USDT', 1)).rejects.toThrow();
    expect(md.grader.grade(new Date(0)).rejectRateBps).toBe(10_000);
  });

  it('records a transport failure as an error and reports the venue unreachable', async () => {
    const md = new BinanceSpotMarketData({
      http: {
        get: async () => {
          throw new Error('ECONNRESET');
        },
      },
      stream: new FakeStream(),
      clock: () => 0,
    });
    await expect(md.snapshotBook('BTC/USDT', 1)).rejects.toThrow(/ECONNRESET/);
    expect(md.grader.grade(new Date(0)).errorRateBps).toBe(10_000);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE TRADING HALF — loud, not plausible
// ════════════════════════════════════════════════════════════════════════════

describe('BinanceSpotTrade / BinanceSpotAccount without credentials', () => {
  const order = {
    symbol: 'BTC/USDT',
    side: 'buy' as const,
    type: 'limit' as const,
    amount: 1n,
    price: 1n,
    clientOrderId: 'abc',
  };

  it('THROWS on placeOrder rather than returning a plausible rejection', async () => {
    // A `{ status: 'rejected' }` here would let a router "try" the venue, route
    // the rest elsewhere, and call the result a fill.
    await expect(new BinanceSpotTrade().placeOrder(order)).rejects.toThrow(VenueCredentialsMissingError);
  });

  it('names the operation and tells the owner what to do', async () => {
    try {
      await new BinanceSpotTrade().placeOrder(order);
      expect.unreachable('should have thrown');
    } catch (error) {
      const missing = error as VenueCredentialsMissingError;
      expect(missing.venueId).toBe('binance-spot');
      expect(missing.operation).toBe('placeOrder');
      expect(missing.message).toContain('TRADE-ONLY key');
    }
  });

  it('throws on every credentialed method, including the read-only-looking ones', async () => {
    const trade = new BinanceSpotTrade();
    const account = new BinanceSpotAccount();

    await expect(trade.cancelOrder('BTC/USDT', 'abc')).rejects.toThrow(VenueCredentialsMissingError);
    await expect(trade.fetchOrder('BTC/USDT', 'abc')).rejects.toThrow(VenueCredentialsMissingError);
    // NOT an empty array — that is indistinguishable from "we are flat".
    await expect(trade.openOrders()).rejects.toThrow(VenueCredentialsMissingError);
    await expect(account.balances()).rejects.toThrow(VenueCredentialsMissingError);
    await expect(account.positions()).rejects.toThrow(VenueCredentialsMissingError);
    await expect(account.transferRails()).rejects.toThrow(VenueCredentialsMissingError);
  });

  it('REFUSES a withdrawal-capable key at construction, before it is ever stored', () => {
    expect(() => new BinanceSpotTrade({ venueId: 'binance-spot', apiKey: 'k', apiSecret: 's', scopes: ['trade', 'withdraw'] })).toThrow(
      VenueCredentialScopeError,
    );
    expect(() => new BinanceSpotAccount({ venueId: 'binance-spot', apiKey: 'k', apiSecret: 's', scopes: ['withdrawals'] })).toThrow(
      VenueCredentialScopeError,
    );
  });

  it('places a signed LIMIT order against the injected HTTP port — never a fabricated fill', async () => {
    const http = new FakeHttp().queue(depthSnapshot(1)).queue({
      symbol: 'BTCUSDT',
      orderId: 42,
      clientOrderId: 'abc',
      transactTime: 1_500_000_000_000,
      price: '100.00',
      origQty: '1',
      executedQty: '0',
      cummulativeQuoteQty: '0',
      status: 'NEW',
      type: 'LIMIT',
      side: 'BUY',
    });
    const keys = { venueId: 'binance-spot' as const, apiKey: 'k', apiSecret: 's', scopes: ['read', 'trade'] as const };
    const trade = new BinanceSpotTrade(keys, {
      http,
      restBase: 'https://rest.test',
      clock: () => 1_700_000_000_000,
      snapshotLimit: 5,
    });
    const placed = await trade.placeOrder({
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      amount: 1n * 10n ** 18n,
      price: 100n * 10n ** 18n,
      clientOrderId: 'abc',
    });
    expect(placed.status).toBe('open');
    expect(placed.filled).toBe(0n);
    expect(placed.venueOrderId).toBe('42');
    expect(http.requests[0]).toContain('/api/v3/depth?symbol=BTCUSDT&limit=5');
    expect(http.requests[1]).toMatch(/^POST https:\/\/rest\.test\/api\/v3\/order\?/);
    expect(http.requests[1]).toContain('signature=');
    expect(http.requests[1]).toContain('newClientOrderId=abc');
    expect(http.requests[1]).toContain('timeInForce=GTC');
  });

  it('sends IOC when asked and refuses a client id over 36 characters before any HTTP call', async () => {
    const http = new FakeHttp().queue(depthSnapshot(1)).queue({
      symbol: 'BTCUSDT',
      orderId: 43,
      clientOrderId: 'ioc',
      transactTime: 1_500_000_000_000,
      price: '100.00',
      origQty: '1',
      executedQty: '0',
      cummulativeQuoteQty: '0',
      status: 'EXPIRED',
      type: 'LIMIT',
      side: 'SELL',
    });
    const keys = { venueId: 'binance-spot' as const, apiKey: 'k', apiSecret: 's', scopes: ['read', 'trade'] as const };
    const trade = new BinanceSpotTrade(keys, {
      http,
      restBase: 'https://rest.test',
      clock: () => 1_700_000_000_000,
      snapshotLimit: 5,
    });
    await trade.placeOrder({
      symbol: 'BTC/USDT',
      side: 'sell',
      type: 'limit',
      timeInForce: 'IOC',
      amount: 1n * 10n ** 18n,
      price: 100n * 10n ** 18n,
      clientOrderId: 'ioc',
    });
    expect(http.requests[1]).toContain('timeInForce=IOC');
    const blocked = new FakeHttp();
    const refused = new BinanceSpotTrade(keys, { http: blocked, restBase: 'https://rest.test', clock: () => 1, snapshotLimit: 5 });
    await expect(
      refused.placeOrder({
        symbol: 'BTC/USDT',
        side: 'sell',
        type: 'limit',
        amount: 1n,
        price: 1n,
        clientOrderId: 'x'.repeat(37),
      }),
    ).rejects.toMatchObject({ sent: false });
    expect(blocked.requests).toHaveLength(0);
  });

  it('keeps average fill price in the shared 18-decimal scale', () => {
    const mapped = mapBinanceSpotOrder(
      {
        orderId: 42,
        clientOrderId: 'abc',
        transactTime: 1_500_000_000_000,
        price: '100',
        origQty: '2',
        executedQty: '1.5',
        cummulativeQuoteQty: '150',
        status: 'PARTIALLY_FILLED',
        type: 'LIMIT',
        side: 'BUY',
      },
      'BTC/USDT',
      new Date(1_700_000_000_000),
    );

    expect(formatAmount(mapped.averagePrice!)).toBe('100');
  });

  it('maps EXPIRED_IN_MATCH with a partial fill instead of dropping the quantity', () => {
    const mapped = mapBinanceSpotOrder(
      {
        orderId: 42,
        clientOrderId: 'abc',
        transactTime: 1_500_000_000_000,
        price: '1',
        origQty: '1',
        executedQty: '0.4',
        cummulativeQuoteQty: '0.4',
        status: 'EXPIRED_IN_MATCH',
        type: 'LIMIT',
        side: 'SELL',
      },
      'USD/USDT',
      new Date(1_700_000_000_000),
    );
    expect(mapped.status).toBe('expired');
    expect(formatAmount(mapped.filled)).toBe('0.4');
    expect(mapped.feePaid).toBeNull();
  });

  it('refuses unknown venue side and type instead of silently mapping them to buy/limit', () => {
    const base = {
      orderId: 42,
      clientOrderId: 'abc',
      price: '100',
      origQty: '1',
      executedQty: '0',
      cummulativeQuoteQty: '0',
      status: 'NEW',
      type: 'LIMIT',
      side: 'BUY',
    };

    expect(() => mapBinanceSpotOrder({ ...base, side: 'UNKNOWN' }, 'BTC/USDT', new Date())).toThrow(/order side UNKNOWN/);
    expect(() => mapBinanceSpotOrder({ ...base, type: 'UNKNOWN' }, 'BTC/USDT', new Date())).toThrow(/order type UNKNOWN/);
  });

  it('refuses missing identifiers instead of returning an uncorrelatable order', () => {
    const base = {
      orderId: 42,
      clientOrderId: 'abc',
      price: '100',
      origQty: '1',
      executedQty: '0',
      cummulativeQuoteQty: '0',
      status: 'NEW',
      type: 'LIMIT',
      side: 'BUY',
    };

    expect(() => mapBinanceSpotOrder({ ...base, orderId: null }, 'BTC/USDT', new Date())).toThrow(/orderId is missing/);
    expect(() => mapBinanceSpotOrder({ ...base, clientOrderId: ' ' }, 'BTC/USDT', new Date())).toThrow(/clientOrderId is missing/);
  });

  it('refuses impossible signed quantities, quote totals, and limit prices', () => {
    const base = {
      orderId: 42,
      clientOrderId: 'abc',
      price: '100',
      origQty: '1',
      executedQty: '0',
      cummulativeQuoteQty: '0',
      status: 'NEW',
      type: 'LIMIT',
      side: 'BUY',
    };

    expect(() => mapBinanceSpotOrder({ ...base, origQty: '0' }, 'BTC/USDT', new Date())).toThrow(/origQty must be positive/);
    expect(() => mapBinanceSpotOrder({ ...base, executedQty: '-0.1' }, 'BTC/USDT', new Date())).toThrow(/unsigned decimal/);
    expect(() => mapBinanceSpotOrder({ ...base, cummulativeQuoteQty: '-1' }, 'BTC/USDT', new Date())).toThrow(/unsigned decimal/);
    expect(() => mapBinanceSpotOrder({ ...base, price: '0' }, 'BTC/USDT', new Date())).toThrow(/price must be positive/);
  });

  it('refuses contradictory execution and cumulative quote totals', () => {
    const base = {
      orderId: 42,
      clientOrderId: 'abc',
      price: '100',
      origQty: '1',
      executedQty: '0',
      cummulativeQuoteQty: '0',
      status: 'NEW',
      type: 'LIMIT',
      side: 'BUY',
    };

    expect(() => mapBinanceSpotOrder({ ...base, executedQty: '0.5' }, 'BTC/USDT', new Date())).toThrow(/both be zero or both be positive/);
    expect(() => mapBinanceSpotOrder({ ...base, cummulativeQuoteQty: '10' }, 'BTC/USDT', new Date())).toThrow(
      /both be zero or both be positive/,
    );
  });

  it('refuses unscoped openOrders rather than leaking native venue symbols', async () => {
    const keys = { venueId: 'binance-spot' as const, apiKey: 'k', apiSecret: 's', scopes: ['read', 'trade'] as const };
    const http = new FakeHttp();
    const trade = new BinanceSpotTrade(keys, { http, restBase: 'https://rest.test', clock: () => 1 });

    await expect(trade.openOrders()).rejects.toMatchObject({ reason: 'not_ready' });
    expect(http.requests).toEqual([]);
  });

  it('throws the venue error body instead of returning a fake rejected order', async () => {
    const http = new FakeHttp().queue(depthSnapshot(1)).queue({ code: -2010, msg: 'insufficient balance' }, 400);
    const keys = { venueId: 'binance-spot' as const, apiKey: 'k', apiSecret: 's', scopes: ['read', 'trade'] as const };
    const trade = new BinanceSpotTrade(keys, { http, restBase: 'https://rest.test', clock: () => 1, snapshotLimit: 5 });
    await expect(
      trade.placeOrder({
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'limit',
        amount: 1n * 10n ** 18n,
        price: 100n * 10n ** 18n,
        clientOrderId: 'abc',
      }),
    ).rejects.toMatchObject({ reason: 'unreachable', sent: true });
  });

  it('tags a follow-up myTrades governor refusal as sent', async () => {
    const http = new FakeHttp().queue(depthSnapshot(1)).queue({
      symbol: 'BTCUSDT',
      orderId: 28,
      clientOrderId: 'abc',
      transactTime: 1_507_725_176_595,
      price: '100.00',
      origQty: '1.00000000',
      executedQty: '1.00000000',
      cummulativeQuoteQty: '100.00000000',
      status: 'FILLED',
      type: 'LIMIT',
      side: 'SELL',
    });
    const governor = new RateLimitGovernor(
      { venueId: 'binance-spot', capacity: 1, windowMs: 60_000, reservedHeadroomBps: 0, burstBps: 10_000 },
      1,
    );
    const keys = { venueId: 'binance-spot' as const, apiKey: 'k', apiSecret: 's', scopes: ['read', 'trade'] as const };
    const trade = new BinanceSpotTrade(keys, {
      http,
      restBase: 'https://rest.test',
      clock: () => 1,
      snapshotLimit: 5,
      governor,
    });
    await expect(
      trade.placeOrder({
        symbol: 'BTC/USDT',
        side: 'sell',
        type: 'limit',
        amount: 1n * 10n ** 18n,
        price: 100n * 10n ** 18n,
        clientOrderId: 'abc',
      }),
    ).rejects.toMatchObject({ sent: true, reason: 'rate_limited' });
    expect(http.requests.some((url) => url.includes('POST ') && url.includes('/api/v3/order'))).toBe(true);
    expect(http.requests.some((url) => url.includes('/api/v3/myTrades'))).toBe(false);
  });

  it('balances maps free/locked from signed GET /api/v3/account — never a ledger input', async () => {
    const http = new FakeHttp().queue({
      balances: [
        { asset: 'BTC', free: '1.5', locked: '0.5' },
        { asset: 'USDT', free: '100', locked: '0' },
      ],
    });
    const keys = { venueId: 'binance-spot' as const, apiKey: 'k', apiSecret: 's', scopes: ['read', 'trade'] as const };
    const account = new BinanceSpotAccount(keys, { http, restBase: 'https://rest.test', clock: () => 1_700_000_000_000 });
    const rows = await account.balances();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.asset).toBe('BTC');
    expect(formatAmount(rows[0]!.free)).toBe('1.5');
    expect(formatAmount(rows[0]!.used)).toBe('0.5');
    expect(formatAmount(rows[0]!.total)).toBe('2');
    expect(http.requests[0]).toMatch(/^https:\/\/rest\.test\/api\/v3\/account\?/);
    expect(http.requests[0]).toContain('signature=');
  });

  it('spot positions is [] — honest empty, not not_ready', async () => {
    const keys = { venueId: 'binance-spot' as const, apiKey: 'k', apiSecret: 's', scopes: ['read', 'trade'] as const };
    expect(await new BinanceSpotAccount(keys, { http: new FakeHttp() }).positions()).toEqual([]);
  });

  it('transferRails stays not_ready — wallet permission refused', async () => {
    const keys = { venueId: 'binance-spot' as const, apiKey: 'k', apiSecret: 's', scopes: ['read', 'trade'] as const };
    await expect(new BinanceSpotAccount(keys).transferRails()).rejects.toMatchObject({ reason: 'not_ready' });
  });

  it('createListenKey POSTs userDataStream with the API key header', async () => {
    const http = new FakeHttp().queue({ listenKey: 'lk-1' });
    const keys = { venueId: 'binance-spot' as const, apiKey: 'k', apiSecret: 's', scopes: ['read', 'trade'] as const };
    const key = await new BinanceSpotAccount(keys, { http, restBase: 'https://rest.test' }).createListenKey();
    expect(key).toBe('lk-1');
    expect(http.requests[0]).toBe('POST https://rest.test/api/v3/userDataStream');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// END TO END — the whole fabric on a fake venue
// ════════════════════════════════════════════════════════════════════════════

describe('MaintainedBook — subscribe, buffer, snapshot, join, resnapshot', () => {
  /** Let the pending microtasks (the seeding fetch, the delta pump) settle. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('subscribes BEFORE snapshotting, and joins across the buffered window', async () => {
    const http = new FakeHttp().queue(depthSnapshot(100));
    const stream = new FakeStream();
    const book = new MaintainedBook(adapter(http, stream), 'BTC/USDT');

    const running = book.run();
    await settle();

    // The socket was opened first. That ordering is the whole point: updates in
    // this window would otherwise be lost with no discontinuity to prove it.
    expect(stream.opened).toHaveLength(1);

    stream.socket().push(depthEvent(101, 101, { b: [['30001.00', '3.00']] }));
    await settle();

    expect(book.servable).toBe(true);
    expect(book.status).toEqual({ kind: 'live', sequence: 101 });
    expect(formatAmount(book.top()!.bestBid!)).toBe('30001');

    await book.close();
    stream.socket().close();
    await running;
  });

  it('WITHHOLDS the book on a gap and fetches a fresh snapshot', async () => {
    const http = new FakeHttp().queue(depthSnapshot(100)).queue(depthSnapshot(200));
    const stream = new FakeStream();
    const book = new MaintainedBook(adapter(http, stream), 'BTC/USDT');

    const running = book.run();
    await settle();
    stream.socket().push(depthEvent(101, 101, { b: [['30001.00', '3.00']] }));
    await settle();
    expect(book.servable).toBe(true);

    // 102 never arrives.
    stream.socket().push(depthEvent(103, 103, { b: [['31000.00', '9.00']] }));
    await settle();

    expect(book.tracker.lastDesync?.reason).toBe('gap');
    // Two snapshots fetched: the seed and the rebuild.
    expect(http.requests).toHaveLength(2);
    // Rebuilt at 200, and the gapped 31000 bid did NOT survive.
    expect(book.servable).toBe(true);
    expect(formatAmount(book.top()!.bestBid!)).toBe('30000');

    await book.close();
    stream.socket().close();
    await running;
  });

  it('retries when the REST snapshot lags its own websocket, rather than joining across the hole', async () => {
    // First snapshot is older than what the stream has already delivered.
    const http = new FakeHttp().queue(depthSnapshot(50)).queue(depthSnapshot(104));
    const stream = new FakeStream();
    const book = new MaintainedBook(adapter(http, stream), 'BTC/USDT');

    const running = book.run();
    await settle();
    stream.socket().push(depthEvent(105, 105, { b: [['30001.00', '3.00']] }));
    await settle();

    expect(http.requests).toHaveLength(2);
    expect(book.servable).toBe(true);
    expect(book.tracker.sequence).toBe(105);

    await book.close();
    stream.socket().close();
    await running;
  });

  it('STOPS rather than resnapshot-storming a venue that keeps gapping', async () => {
    // Each rebuild succeeds; the stream just keeps losing updates. Left
    // unbounded this is a request storm that gets us rate-limited on top of
    // whatever the venue's own problem is.
    const http = new FakeHttp();
    for (const sequence of [100, 110, 120, 130]) http.queue(depthSnapshot(sequence));

    const stream = new FakeStream();
    const book = new MaintainedBook(adapter(http, stream), 'BTC/USDT', { maxResyncs: 2 });

    const running = book.run();
    await settle();

    for (const sequence of [110, 120, 130]) {
      stream.socket().push(depthEvent(sequence, sequence));
      await settle();
    }
    stream.socket().close();

    const status = await running;
    expect(status.kind).toBe('stopped');
    expect(status.kind === 'stopped' && status.reason).toContain('resnapshot-storming');
    // Excluded and reported — and the book is gone, not stale-but-served.
    expect(book.servable).toBe(false);
    expect(book.top()).toBeNull();
    expect(book.levels('bids')).toEqual([]);
  });

  it('gives up honestly when the REST endpoint never catches its own websocket up', async () => {
    // Every snapshot comes back older than the buffered stream. Retrying
    // forever against that is the same storm by a different route.
    const http = new FakeHttp();
    for (let i = 0; i < 5; i += 1) http.queue(depthSnapshot(50));

    const stream = new FakeStream();
    const book = new MaintainedBook(adapter(http, stream), 'BTC/USDT', { maxSnapshotAttempts: 3 });

    const running = book.run();
    await settle();
    stream.socket().push(depthEvent(200, 200));
    await settle();
    stream.socket().close();

    const status = await running;
    expect(status.kind).toBe('stopped');
    expect(status.kind === 'stopped' && status.reason).toContain('lagging its own websocket');
    // The seed, then three bounded rebuild attempts. Not a loop.
    expect(http.requests).toHaveLength(4);
    expect(book.servable).toBe(false);
  });

  it('runs a 200-frame stream through the real adapter without drifting', async () => {
    const http = new FakeHttp().queue(depthSnapshot(0));
    const stream = new FakeStream();
    const book = new MaintainedBook(adapter(http, stream), 'BTC/USDT');

    const running = book.run();
    await settle();

    for (let i = 1; i <= 200; i += 1) {
      stream.socket().push(depthEvent(i, i, { b: [['30001.00', `${i}.00`]] }));
    }
    await settle();

    expect(book.tracker.sequence).toBe(200);
    expect(book.tracker.resyncCount).toBe(0);
    // One snapshot for the whole run: no self-inflicted resnapshot loop.
    expect(http.requests).toHaveLength(1);
    expect(formatAmount(book.levels('bids')[0]![1])).toBe('200');

    await book.close();
    stream.socket().close();
    await running;
  });
});

describe('Binance spot commission and filters', () => {
  const keys = { venueId: 'binance-spot' as const, apiKey: 'k', apiSecret: 's', scopes: ['read', 'trade'] as const };
  const filled = {
    symbol: 'BTCUSDT',
    orderId: 28,
    clientOrderId: 'abc',
    transactTime: 1_507_725_176_595,
    price: '100.00',
    origQty: '1.00000000',
    executedQty: '1.00000000',
    cummulativeQuoteQty: '100.00000000',
    status: 'FILLED',
    type: 'LIMIT',
    side: 'SELL',
  };

  it('sums FULL fills of one asset and leaves a missing or mixed commission unknown', () => {
    const one = sumBinanceFillCommission([
      { price: '100', qty: '0.4', commission: '0.10', commissionAsset: 'USDT', tradeId: 1 },
      { price: '100', qty: '0.6', commission: '0.25', commissionAsset: 'USDT', tradeId: 2 },
    ]);
    expect(formatAmount(one.feePaid!)).toBe('0.35');
    expect(one.feeAsset).toBe('USDT');
    expect(sumBinanceFillCommission([])).toEqual({ feePaid: null, feeAsset: null });
    expect(
      sumBinanceFillCommission([
        { commission: '0.1', commissionAsset: 'USDT' },
        { commission: '0.01', commissionAsset: 'BNB' },
      ]),
    ).toEqual({ feePaid: null, feeAsset: null });
    expect(sumBinanceFillCommission([{ price: '100', qty: '1' }])).toEqual({ feePaid: null, feeAsset: null });
  });

  it('sends newOrderRespType=FULL and books the commission on the order response', async () => {
    const http = new FakeHttp().queue(depthSnapshot(1)).queue({
      ...filled,
      fills: [
        { price: '100.00', qty: '0.4', commission: '0.10', commissionAsset: 'USDT', tradeId: 1 },
        { price: '100.00', qty: '0.6', commission: '0.25', commissionAsset: 'USDT', tradeId: 2 },
      ],
    });
    const trade = new BinanceSpotTrade(keys, { http, restBase: 'https://rest.test', clock: () => 1_700_000_000_000, snapshotLimit: 5 });
    const placed = await trade.placeOrder({
      symbol: 'BTC/USDT',
      side: 'sell',
      type: 'limit',
      amount: 1n * 10n ** 18n,
      price: 100n * 10n ** 18n,
      timeInForce: 'IOC',
      clientOrderId: 'abc',
    });
    expect(formatAmount(placed.feePaid!)).toBe('0.35');
    expect(placed.feeAsset).toBe('USDT');
    expect(http.requests[1]).toContain('newOrderRespType=FULL');
    expect(http.requests.some((url) => url.includes('/api/v3/myTrades'))).toBe(false);
  });

  it('reads commission from myTrades when the order row has no fills', async () => {
    const http = new FakeHttp().queue(filled).queue([
      { commission: '0.10', commissionAsset: 'USDT', qty: '0.4', price: '100' },
      { commission: '0.25', commissionAsset: 'USDT', qty: '0.6', price: '100' },
    ]);
    const trade = new BinanceSpotTrade(keys, { http, restBase: 'https://rest.test', clock: () => 1_700_000_000_000 });
    const order = await trade.fetchOrder('BTC/USDT', 'abc');
    expect(formatAmount(order.feePaid!)).toBe('0.35');
    expect(order.feeAsset).toBe('USDT');
    expect(http.requests[0]).toContain('/api/v3/order');
    expect(http.requests[1]).toContain('/api/v3/myTrades');
    expect(http.requests[1]).toContain('orderId=28');
  });

  it('names a definite rejection by its venue code', async () => {
    const http = new FakeHttp().queue(depthSnapshot(1)).queue({ code: -2010, msg: 'insufficient balance' }, 400);
    const trade = new BinanceSpotTrade(keys, { http, restBase: 'https://rest.test', clock: () => 1, snapshotLimit: 5 });
    await expect(
      trade.placeOrder({
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'limit',
        amount: 1n * 10n ** 18n,
        price: 100n * 10n ** 18n,
        clientOrderId: 'abc',
      }),
    ).rejects.toThrow(/code -2010 \(insufficient balance\)/);
  });

  it('reads the taker-sell rate and refuses a BNB discount or a missing leg', () => {
    const leg = { maker: '0', taker: '0.001', buyer: '0', seller: '0' };
    const zero = { maker: '0', taker: '0', buyer: '0', seller: '0' };
    const body = {
      standardCommission: leg,
      specialCommission: zero,
      taxCommission: zero,
      discount: { enabledForAccount: false, enabledForSymbol: false },
    };
    expect(formatAmount(binanceTakerSellCommissionRate(body)!)).toBe('0.001');
    expect(formatAmount(binanceTakerSellCommissionRate({ ...body, specialCommission: { ...zero, taker: '0.0004' } })!)).toBe('0.0004');
    expect(binanceTakerSellCommissionRate({ ...body, discount: { enabledForAccount: true, enabledForSymbol: false } })).toBeNull();
    expect(binanceTakerSellCommissionRate({ ...body, taxCommission: undefined })).toBeNull();
  });

  it('reads tick, step and min notional, and returns null when a filter is absent', async () => {
    const symbol = {
      symbol: 'BTCUSDT',
      status: 'TRADING',
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.01' },
        { filterType: 'LOT_SIZE', stepSize: '0.00001' },
        { filterType: 'NOTIONAL', minNotional: '5' },
      ],
    };
    expect(formatAmount(binanceSymbolFilters(symbol)!.tickSize)).toBe('0.01');
    expect(formatAmount(binanceSymbolFilters(symbol)!.stepSize)).toBe('0.00001');
    expect(formatAmount(binanceSymbolFilters(symbol)!.minNotional)).toBe('5');
    expect(binanceSymbolFilters({ ...symbol, status: 'HALT' })).toBeNull();
    expect(binanceSymbolFilters({ ...symbol, filters: symbol.filters.slice(0, 2) })).toBeNull();
    const http = new FakeHttp().queue({ symbols: [symbol] });
    const trade = new BinanceSpotTrade(keys, { http, restBase: 'https://rest.test', clock: () => 1 });
    const filters = await trade.symbolFilters('BTC/USDT');
    expect(formatAmount(filters!.minNotional)).toBe('5');
    expect(http.requests[0]).toBe('https://rest.test/api/v3/exchangeInfo?symbol=BTCUSDT');
    const empty = new FakeHttp().queue({ symbols: [] });
    expect(await new BinanceSpotTrade(keys, { http: empty, restBase: 'https://rest.test' }).symbolFilters('BTC/USDT')).toBeNull();
  });

  it('reads the account commission endpoint', async () => {
    const http = new FakeHttp().queue({
      standardCommission: { maker: '0', taker: '0.001', buyer: '0', seller: '0' },
      specialCommission: { maker: '0', taker: '0', buyer: '0', seller: '0' },
      taxCommission: { maker: '0', taker: '0', buyer: '0', seller: '0' },
      discount: { enabledForAccount: false, enabledForSymbol: false },
    });
    const trade = new BinanceSpotTrade(keys, { http, restBase: 'https://rest.test', clock: () => 1 });
    expect(formatAmount((await trade.commissionRate('BTC/USDT'))!)).toBe('0.001');
    expect(http.requests[0]).toContain('/api/v3/account/commission');
    expect(http.requests[0]).toContain('symbol=BTCUSDT');
  });

  const missing = { code: -2013, msg: 'Order does not exist.' };
  const window = { startTimeMs: 1_700_000_000_000 - 60_000, endTimeMs: 1_700_000_000_000 };

  it('treats an empty allOrders and myTrades window as a miss', async () => {
    const http = new FakeHttp().queue(missing, 400).queue([]).queue([]);
    const trade = new BinanceSpotTrade(keys, { http, restBase: 'https://rest.test', clock: () => window.endTimeMs });
    await expect(trade.fetchClosedOrder('BTC/USDT', 'abc', window)).resolves.toBeNull();
    expect(http.requests[1]).toContain('/api/v3/allOrders');
    expect(http.requests[2]).toContain('/api/v3/myTrades');
  });

  it('is not a miss when allOrders contains the clientOrderId', async () => {
    const http = new FakeHttp()
      .queue(missing, 400)
      .queue([filled])
      .queue([{ commission: '0.10', commissionAsset: 'USDT', qty: '1', price: '100' }]);
    const trade = new BinanceSpotTrade(keys, { http, restBase: 'https://rest.test', clock: () => window.endTimeMs });
    const order = await trade.fetchClosedOrder('BTC/USDT', 'abc', window);
    expect(order?.venueOrderId).toBe('28');
    expect(order?.status).toBe('filled');
  });

  it('is not a miss when myTrades names the orderId inside the claim window', async () => {
    const http = new FakeHttp()
      .queue(missing, 400)
      .queue([])
      .queue([{ orderId: 28, qty: '1', price: '100' }])
      .queue(filled)
      .queue([{ commission: '0.10', commissionAsset: 'USDT', qty: '1', price: '100' }]);
    const trade = new BinanceSpotTrade(keys, { http, restBase: 'https://rest.test', clock: () => window.endTimeMs });
    const order = await trade.fetchClosedOrder('BTC/USDT', 'abc', { ...window, orderId: '28' });
    expect(order?.clientOrderId).toBe('abc');
    expect(http.requests.some((url) => url.includes('orderId=28') && !url.includes('myTrades'))).toBe(true);
  });

  it('refuses a full history page instead of calling it a miss', async () => {
    const page = Array.from({ length: 1000 }, () => ({ clientOrderId: 'other' }));
    const http = new FakeHttp().queue(missing, 400).queue(page);
    const trade = new BinanceSpotTrade(keys, { http, restBase: 'https://rest.test', clock: () => window.endTimeMs });
    await expect(trade.fetchClosedOrder('BTC/USDT', 'abc', window)).rejects.toThrow(/history page is full/);
  });

  it('refuses a closed-order lookup that has no claim window', async () => {
    const http = new FakeHttp().queue(missing, 400);
    const trade = new BinanceSpotTrade(keys, { http, restBase: 'https://rest.test', clock: () => window.endTimeMs });
    await expect(trade.fetchClosedOrder('BTC/USDT', 'abc')).rejects.toThrow(/no claim window/);
  });
});
