import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import {
  VenueCapabilityError,
  VenueCredentialsMissingError,
  VenueUnavailableError,
  type VenueCredentials,
} from '@intafaced/venue-contracts';
import { SequencedBookTracker } from '../sequenced-book.js';
import { RateLimitGovernor } from '../rate-limit.js';
import type { HttpPort, HttpRequestInit, HttpResponse, StreamHandle, StreamPort } from '../transport.js';
import {
  capDepth,
  OKX_SPOT_RATE_LIMIT,
  OkxSpotAccount,
  OkxSpotMarketData,
  OkxSpotTrade,
  okxSymbolOf,
  retryAfterFrom,
  subscribeRefusal,
  takerSideOf,
} from './okx-spot.js';
import { mapOkxSpotOrder, signOkxRequest } from './okx-spot-trade.js';

class FakeHttp implements HttpPort {
  readonly requests: string[] = [];
  readonly calls: Array<{ method: 'GET' | 'POST'; url: string; init?: HttpRequestInit }> = [];
  constructor(
    private readonly responder: (url: string, method?: 'GET' | 'POST', init?: HttpRequestInit) => HttpResponse | Promise<HttpResponse>,
  ) {}
  async get(url: string, init?: HttpRequestInit): Promise<HttpResponse> {
    this.requests.push(url);
    this.calls.push({ method: 'GET', url, init });
    return this.responder(url, 'GET', init);
  }
  async post(url: string, init?: HttpRequestInit): Promise<HttpResponse> {
    this.requests.push(url);
    this.calls.push({ method: 'POST', url, init });
    return this.responder(url, 'POST', init);
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return { status, body, header: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null };
}

function thickBook(seqId = 42) {
  return {
    code: '0',
    msg: '',
    data: [
      {
        asks: [['30002.10', '1.5', '0', '1']],
        bids: [['30000.00', '2.0', '0', '1']],
        ts: '1700000000000',
        seqId,
      },
    ],
  };
}

function instrument(instId: string, extra: Record<string, unknown> = {}) {
  const [base, quote] = instId.split('-');
  return {
    instId,
    instType: 'SPOT',
    baseCcy: base,
    quoteCcy: quote,
    tickSz: '0.1',
    lotSz: '0.0001',
    minSz: '0.0001',
    maxLmtSz: '1000',
    state: 'live',
    ...extra,
  };
}

class ScriptedStream implements StreamPort {
  readonly opened: string[] = [];
  readonly sent: unknown[] = [];
  readonly closed: number[] = [];
  #queue: Array<IteratorResult<unknown>> = [];
  #waiters: Array<(r: IteratorResult<unknown>) => void> = [];
  #closed = false;
  sendEnabled = true;

  push(value: unknown): void {
    const result = { value, done: false as const };
    const waiter = this.#waiters.shift();
    if (waiter) waiter(result);
    else this.#queue.push(result);
  }

  end(): void {
    this.#closed = true;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: undefined, done: true });
    else this.#queue.push({ value: undefined, done: true });
  }

  async open(url: string): Promise<StreamHandle> {
    this.opened.push(url);
    const messages: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<unknown>> => {
          if (this.#queue.length > 0) return this.#queue.shift()!;
          if (this.#closed) return { value: undefined, done: true };
          return new Promise((resolve) => this.#waiters.push(resolve));
        },
      }),
    };
    return {
      messages,
      send: this.sendEnabled
        ? async (payload) => {
            this.sent.push(payload);
          }
        : undefined,
      close: async () => {
        this.closed.push(1);
        this.end();
      },
    };
  }
}

function adapter(http: HttpPort, extras: ConstructorParameters<typeof OkxSpotMarketData>[0] = {}) {
  return new OkxSpotMarketData({ http, heartbeatMs: 0, ...extras });
}

describe('okx-spot — public market data (third venue)', () => {
  it('maps unified symbols to hyphenated venue spelling (BTC/USDT → BTC-USDT)', () => {
    expect(okxSymbolOf('BTC/USDT')).toBe('BTC-USDT');
    expect(okxSymbolOf('eth/usdt')).toBe('ETH-USDT');
    expect(okxSymbolOf('BTC-USDT')).toBe('BTC-USDT');
    expect(okxSymbolOf('BTCUSDT')).toBe('BTCUSDT');
  });

  it('caps depth onto the venue closed set {1,5,10,50,100,200,400}', () => {
    expect(capDepth(1)).toBe(1);
    expect(capDepth(3)).toBe(1);
    expect(capDepth(5)).toBe(5);
    expect(capDepth(99)).toBe(50);
    expect(capDepth(100)).toBe(100);
    expect(capDepth(250)).toBe(200);
    expect(capDepth(400)).toBe(400);
    expect(capDepth(999)).toBe(400);
    expect(capDepth(0)).toBe(1);
  });

  it('normalizes live instruments and refuses JSON-number precision', async () => {
    const http = new FakeHttp(() =>
      json(200, { code: '0', msg: '', data: [instrument('BTC-USDT'), instrument('ETH-USDT', { state: 'suspend' })] }),
    );
    const markets = await adapter(http).markets();
    expect(markets).toHaveLength(2);
    expect(markets[0]!.symbol).toBe('BTC/USDT');
    expect(markets[0]!.venueSymbol).toBe('BTC-USDT');
    expect(markets[0]!.type).toBe('spot');
    expect(markets[0]!.active).toBe(true);
    expect(markets[1]!.active).toBe(false);
    expect(formatAmount(markets[0]!.precision.price)).toBe('0.1');
    expect(markets[0]!.fees.indicative).toBe(true);
    expect(http.requests[0]).toContain('/api/v5/public/instruments?instType=SPOT');

    const numbers = new FakeHttp(() => json(200, { code: '0', msg: '', data: [instrument('BTC-USDT', { tickSz: 0.1 })] }));
    await expect(adapter(numbers).markets()).rejects.toThrow(/JSON number/);
  });

  it('snapshotBook reads string levels + seqId and grades the round-trip', async () => {
    const http = new FakeHttp(() => json(200, thickBook(7)));
    const md = adapter(http, { restBase: 'https://rest.test' });
    const snapshot = await md.snapshotBook('BTC/USDT', 100);
    expect(snapshot.venueId).toBe('okx-spot');
    expect(snapshot.symbol).toBe('BTC/USDT');
    expect(snapshot.sequenced).toBe(true);
    expect(snapshot.sequence).toBe(7);
    expect(formatAmount(snapshot.bids[0]![0])).toBe('30000');
    expect(formatAmount(snapshot.asks[0]![0])).toBe('30002.1');
    expect(http.requests[0]).toBe('https://rest.test/api/v5/market/books?instId=BTC-USDT&sz=100');
    expect(md.latencyGrade().samples).toBe(1);
    expect(md.latencyGrade().rejectRateBps).toBe(0);
  });

  it('passes empty and one-sided books through, and refuses a two-sided dust book as no_depth', async () => {
    const empty = new FakeHttp(() => json(200, { code: '0', msg: '', data: [{ asks: [], bids: [], ts: '1', seqId: 1 }] }));
    const emptySnap = await adapter(empty).snapshotBook('BTC/USDT', 1);
    expect(emptySnap.bids).toEqual([]);
    expect(emptySnap.asks).toEqual([]);

    const oneSided = new FakeHttp(() =>
      json(200, { code: '0', msg: '', data: [{ asks: [['30002.10', '1.5', '0', '1']], bids: [], ts: '1', seqId: 1 }] }),
    );
    const one = await adapter(oneSided).snapshotBook('BTC/USDT', 1);
    expect(one.bids).toEqual([]);
    expect(one.asks).toHaveLength(1);

    const dust = new FakeHttp(() =>
      json(200, {
        code: '0',
        msg: '',
        data: [{ asks: [['30002.10', '0.00000001', '0', '1']], bids: [['30000.00', '0.00000001', '0', '1']], ts: '1', seqId: 1 }],
      }),
    );
    await expect(adapter(dust).snapshotBook('BTC/USDT', 1)).rejects.toMatchObject({ reason: 'no_depth' });
  });

  it('treats code-0 with empty data as not_ready, not an empty book', async () => {
    const http = new FakeHttp(() => json(200, { code: '0', msg: '', data: [] }));
    await expect(adapter(http).snapshotBook('NOPE/USDT', 1)).rejects.toMatchObject({ reason: 'not_ready' });
  });

  it('treats a non-zero code as not_ready (unknown / delisted symbol)', async () => {
    const http = new FakeHttp(() => json(200, { code: '51001', msg: 'Instrument ID does not exist', data: [] }));
    await expect(adapter(http).snapshotBook('NOPE/USDT', 1)).rejects.toMatchObject({
      reason: 'not_ready',
      message: expect.stringMatching(/51001/),
    });
  });

  it('refuses a 200 with no code as malformed', async () => {
    const http = new FakeHttp(() => json(200, { data: [] }));
    await expect(adapter(http).snapshotBook('BTC/USDT', 1)).rejects.toMatchObject({ reason: 'malformed' });
  });

  it('refuses JSON-number book levels', async () => {
    const http = new FakeHttp(() =>
      json(200, { code: '0', msg: '', data: [{ asks: [[30002.1, 1.5]], bids: [[30000, 2]], ts: '1', seqId: 1 }] }),
    );
    await expect(adapter(http).snapshotBook('BTC/USDT', 1)).rejects.toThrow(/JSON number/);
  });

  it('rate-governs BEFORE the request and honors HTTP 429 / body code 50011', async () => {
    const http = new FakeHttp(() => json(200, thickBook()));
    const governor = new RateLimitGovernor(OKX_SPOT_RATE_LIMIT, 0);
    const md = new OkxSpotMarketData({ http, governor, clock: () => 0, heartbeatMs: 0 });
    for (let i = 0; i < 8; i += 1) await md.snapshotBook('BTC/USDT', 1);
    await expect(md.snapshotBook('BTC/USDT', 1)).rejects.toMatchObject({ reason: 'rate_limited' });
    expect(http.requests).toHaveLength(8);

    const backoff = new FakeHttp(() => json(429, { code: '50011', msg: 'Rate limit reached' }, { 'Retry-After': '2' }));
    const md429 = adapter(backoff, { clock: () => 1_000 });
    await expect(md429.snapshotBook('BTC/USDT', 1)).rejects.toMatchObject({ reason: 'rate_limited' });
    expect(md429.governor.tryAcquire(1, 1_000).admitted).toBe(false);
    expect(md429.governor.backoffUntil(1_000)).toBe(3_000);
    expect(md429.governor.backoffUntil(2_999)).toBe(3_000);
    expect(md429.governor.backoffUntil(3_000)).toBeNull();

    const bodyLimit = new FakeHttp(() => json(200, { code: '50011', msg: 'Rate limit reached', data: [] }));
    const mdBody = adapter(bodyLimit);
    await expect(mdBody.snapshotBook('BTC/USDT', 1)).rejects.toMatchObject({
      reason: 'rate_limited',
      message: expect.stringMatching(/50011/),
    });
    expect(mdBody.latencyGrade().samples).toBe(1);
    expect(mdBody.latencyGrade().rejectRateBps).toBe(10_000);
  });

  it('grades a transport failure as unreachable and an error sample', async () => {
    const http = new FakeHttp(() => {
      throw new Error('ECONNRESET');
    });
    const md = adapter(http);
    await expect(md.snapshotBook('BTC/USDT', 1)).rejects.toMatchObject({ reason: 'unreachable' });
    expect(md.latencyGrade().samples).toBe(1);
    expect(md.latencyGrade().errorRateBps).toBe(10_000);
  });

  it('refuses a receive-only StreamPort — this venue subscribes by message', async () => {
    const stream = new ScriptedStream();
    stream.sendEnabled = false;
    const md = new OkxSpotMarketData({
      http: new FakeHttp(() => json(200, thickBook())),
      stream,
      heartbeatMs: 0,
    });
    await expect(md.streamBook('BTC/USDT')).rejects.toBeInstanceOf(VenueCapabilityError);
    await expect(md.streamTrades('BTC/USDT')).rejects.toBeInstanceOf(VenueCapabilityError);
  });

  it('streamBook: subscribe + skip first snapshot + emit updates + fail a second snapshot', async () => {
    const stream = new ScriptedStream();
    const md = new OkxSpotMarketData({
      http: new FakeHttp(() => json(200, thickBook())),
      stream,
      heartbeatMs: 0,
    });
    const sub = await md.streamBook('BTC/USDT');
    expect(stream.opened[0]).toContain('/ws/v5/public');
    expect(stream.sent[0]).toEqual({ op: 'subscribe', args: [{ channel: 'books', instId: 'BTC-USDT' }] });

    const received: unknown[] = [];
    const consume = (async () => {
      for await (const delta of sub.deltas) received.push(delta);
    })();

    stream.push({
      arg: { channel: 'books', instId: 'BTC-USDT' },
      action: 'snapshot',
      data: [{ asks: [['30002.10', '1.5', '0', '1']], bids: [['30000.00', '2.0', '0', '1']], ts: '1', seqId: 100 }],
    });
    stream.push({
      arg: { channel: 'books', instId: 'BTC-USDT' },
      action: 'update',
      data: [{ asks: [['30003.00', '0.5', '0', '1']], bids: [['30001.00', '0']], ts: '2', seqId: 101 }],
    });
    const deadline = Date.now() + 1_000;
    while (received.length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(received).toHaveLength(1);
    const delta = received[0] as { sequence: { firstSequence: number; lastSequence: number }; bids: [string, string][] };
    expect(delta.sequence.firstSequence).toBe(101);
    expect(delta.sequence.lastSequence).toBe(101);
    expect(delta.bids[0]).toEqual(['30001', '0']);

    stream.push({
      arg: { channel: 'books', instId: 'BTC-USDT' },
      action: 'snapshot',
      data: [{ asks: [['1', '1', '0', '1']], bids: [['1', '1', '0', '1']], ts: '3', seqId: 1 }],
    });
    await expect(consume).rejects.toThrow(/re-sent a full snapshot/);
    await sub.close();
  });

  it('streamBook: a subscribe error fails the iterator (no silent socket)', async () => {
    const stream = new ScriptedStream();
    const md = new OkxSpotMarketData({
      http: new FakeHttp(() => json(200, thickBook())),
      stream,
      heartbeatMs: 0,
    });
    const sub = await md.streamBook('BTC/USDT');
    const consume = (async () => {
      for await (const _ of sub.deltas) {
        /* drain */
      }
    })();
    stream.push({ event: 'error', code: '60012', msg: 'Invalid request' });
    await expect(consume).rejects.toThrow(/60012/);
    await sub.close();
  });

  it('streamTrades: subscribe + emit string-priced prints', async () => {
    const stream = new ScriptedStream();
    const md = new OkxSpotMarketData({
      http: new FakeHttp(() => json(200, thickBook())),
      stream,
      heartbeatMs: 0,
    });
    const sub = await md.streamTrades('ETH/USDT');
    expect(stream.sent[0]).toEqual({ op: 'subscribe', args: [{ channel: 'trades', instId: 'ETH-USDT' }] });

    const received: unknown[] = [];
    const consume = (async () => {
      for await (const trade of sub.trades) received.push(trade);
    })();
    stream.push({
      arg: { channel: 'trades', instId: 'ETH-USDT' },
      data: [{ instId: 'ETH-USDT', tradeId: '123', px: '2000.5', sz: '0.4', side: 'buy', ts: '1700000000123' }],
    });
    stream.end();
    await consume;
    expect(received).toHaveLength(1);
    const trade = received[0] as { price: bigint; amount: bigint; takerSide: string; tradeId: string };
    expect(formatAmount(trade.price)).toBe('2000.5');
    expect(formatAmount(trade.amount)).toBe('0.4');
    expect(trade.takerSide).toBe('buy');
    expect(trade.tradeId).toBe('123');
    await sub.close();
  });

  it('heartbeat sends the raw text ping, not a JSON-encoded string', async () => {
    const stream = new ScriptedStream();
    const md = new OkxSpotMarketData({
      http: new FakeHttp(() => json(200, thickBook())),
      stream,
      heartbeatMs: 20,
    });
    const sub = await md.streamBook('BTC/USDT');
    await new Promise((r) => setTimeout(r, 50));
    expect(stream.sent.some((s) => s === 'ping')).toBe(true);
    expect(stream.sent.some((s) => s === '"ping"')).toBe(false);
    await sub.close();
  });

  it('drives SequencedBookTracker: REST seqId seeds, WS seqId continues, a gap withholds the book', async () => {
    const http = new FakeHttp(() => json(200, thickBook(100)));
    const md = adapter(http);
    const snapshot = await md.snapshotBook('BTC/USDT', 1);
    const tracker = new SequencedBookTracker('okx-spot', 'BTC/USDT');
    const seeded = tracker.onSnapshot(snapshot);
    expect(seeded.kind).toBe('applied');
    expect(tracker.state).toBe('live');
    expect(tracker.book()).not.toBeNull();

    const applied = tracker.onDelta({
      venueId: 'okx-spot',
      symbol: 'BTC/USDT',
      sequence: { firstSequence: 101, lastSequence: 101 },
      bids: [['30001', '1']],
      asks: [],
      observedAt: new Date(),
    });
    expect(applied.kind).toBe('applied');

    const gap = tracker.onDelta({
      venueId: 'okx-spot',
      symbol: 'BTC/USDT',
      sequence: { firstSequence: 105, lastSequence: 105 },
      bids: [['30002', '1']],
      asks: [],
      observedAt: new Date(),
    });
    expect(gap.kind).toBe('desynced');
    expect(tracker.state).toBe('desynced');
    expect(tracker.book()).toBeNull();
  });

  it('takerSideOf / subscribeRefusal / retryAfterFrom are exact', () => {
    expect(takerSideOf('buy')).toBe('buy');
    expect(takerSideOf('sell')).toBe('sell');
    expect(takerSideOf('BUY')).toBeNull();
    expect(takerSideOf(1)).toBeNull();
    expect(subscribeRefusal({ event: 'subscribe' })).toBeNull();
    expect(subscribeRefusal({ event: 'error', code: '60012', msg: 'Invalid request' })).toBe('Invalid request code 60012');
    expect(retryAfterFrom('2')).toBe(2_000);
    expect(retryAfterFrom(null)).toBe(60_000);
  });

  it('does not implement trading or account on the public MD adapter', () => {
    const md = adapter(new FakeHttp(() => json(200, thickBook())));
    expect('placeOrder' in md).toBe(false);
    expect('cancelOrder' in md).toBe(false);
    expect('balances' in md).toBe(false);
  });

  it('OkxSpotAccount with keys but no passphrase refuses before HTTP; missing trade keys stay VenueCredentialsMissingError', async () => {
    const keys = { venueId: 'okx-spot', apiKey: 'k', apiSecret: 's', scopes: ['read', 'trade'] as const };
    const order = {
      symbol: 'BTC/USDT',
      side: 'buy' as const,
      type: 'limit' as const,
      amount: 1n,
      price: 1n,
      clientOrderId: 'abc',
    };
    const trade = new OkxSpotTrade();
    const account = new OkxSpotAccount(keys);

    await expect(trade.placeOrder(order)).rejects.toThrow(VenueCredentialsMissingError);
    await expect(trade.cancelOrder('BTC/USDT', 'abc')).rejects.toThrow(VenueCredentialsMissingError);
    await expect(trade.fetchOrder('BTC/USDT', 'abc')).rejects.toThrow(VenueCredentialsMissingError);
    await expect(trade.openOrders()).rejects.toThrow(VenueCredentialsMissingError);

    try {
      await account.balances();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(VenueUnavailableError);
      expect((error as VenueUnavailableError).reason).toBe('not_ready');
      expect((error as VenueUnavailableError).message).toMatch(/passphrase required/);
    }
  });
});

const KEYS: VenueCredentials = {
  venueId: 'okx-spot',
  apiKey: 'okx-key',
  apiSecret: 'okx-secret',
  passphrase: 'okx-pass',
  scopes: ['read', 'trade'],
};

const PLACE = {
  symbol: 'BTC/USDT',
  side: 'buy' as const,
  type: 'limit' as const,
  amount: parseAmount('1'),
  price: parseAmount('30000'),
  clientOrderId: 'abc',
};

const CLOCK = () => Date.parse('2026-08-17T00:00:00.000Z');

function okxOrder(state: string, extra: Record<string, unknown> = {}) {
  return {
    instId: 'BTC-USDT',
    ordId: '1',
    clOrdId: 'abc',
    px: '30000',
    sz: '1',
    accFillSz: '0',
    avgPx: '0',
    state,
    side: 'buy',
    ordType: 'limit',
    cTime: '1700000000000',
    uTime: '1700000000000',
    ...extra,
  };
}

function ack(ordId = '1') {
  return { code: '0', msg: '', data: [{ clOrdId: 'abc', ordId, sCode: '0', sMsg: '' }] };
}

describe('okx-spot — signed trade (FakeHttp, no live network)', () => {
  it('refuses keys without a passphrase after requireCredentials', async () => {
    const noPass = { venueId: 'okx-spot', apiKey: 'k', apiSecret: 's', scopes: ['read', 'trade'] as const };
    const http = new FakeHttp(() => json(200, ack()));
    const trade = new OkxSpotTrade(noPass, { http, clock: CLOCK });
    await expect(trade.placeOrder(PLACE)).rejects.toMatchObject({
      reason: 'not_ready',
      message: expect.stringMatching(/passphrase required/),
    });
    expect(http.calls).toHaveLength(0);
  });

  it('placeOrder POSTs BTC-USDT with OK-ACCESS-SIGN and maps live → open via fetch', async () => {
    const http = new FakeHttp((url, method) => {
      if (url.includes('/api/v5/market/books')) return json(200, thickBook());
      if (method === 'POST') return json(200, ack());
      expect(url).toContain('/api/v5/trade/order?instId=BTC-USDT&clOrdId=abc');
      return json(200, { code: '0', msg: '', data: [okxOrder('live')] });
    });
    const trade = new OkxSpotTrade(KEYS, { http, restBase: 'https://www.okx.com', clock: CLOCK, snapshotLimit: 5 });
    const placed = await trade.placeOrder(PLACE);
    expect(placed.status).toBe('open');
    expect(placed.venueOrderId).toBe('1');
    expect(placed.clientOrderId).toBe('abc');
    expect(formatAmount(placed.amount)).toBe('1');
    expect(formatAmount(placed.remaining)).toBe('1');
    expect(http.calls[0]!.method).toBe('GET');
    expect(http.calls[0]!.url).toContain('/api/v5/market/books');
    expect(http.calls[1]!.method).toBe('POST');
    expect(http.calls[1]!.url).toBe('https://www.okx.com/api/v5/trade/order');
    expect(http.calls[1]!.init?.jsonBody).toMatchObject({
      instId: 'BTC-USDT',
      tdMode: 'cash',
      clOrdId: 'abc',
      side: 'buy',
      ordType: 'limit',
      sz: '1',
      px: '30000',
    });
    const headers = http.calls[1]!.init?.headers ?? {};
    const timestamp = '2026-08-17T00:00:00.000Z';
    const body = JSON.stringify(http.calls[1]!.init?.jsonBody);
    expect(headers['OK-ACCESS-KEY']).toBe('okx-key');
    expect(headers['OK-ACCESS-PASSPHRASE']).toBe('okx-pass');
    expect(headers['OK-ACCESS-TIMESTAMP']).toBe(timestamp);
    expect(headers['OK-ACCESS-SIGN']).toBe(signOkxRequest('okx-secret', timestamp, 'POST', '/api/v5/trade/order', body));
    expect(http.calls[2]!.method).toBe('GET');
    expect(http.calls[2]!.init?.headers?.['OK-ACCESS-SIGN']).toBeTruthy();
  });

  it('market buy sends tgtCcy base_ccy so sz is base size, not quote notional', async () => {
    let postedMarket = false;
    const http = new FakeHttp((url, method, init) => {
      if (url.includes('/api/v5/market/books')) return json(200, thickBook());
      if (method === 'POST') {
        const body = init?.jsonBody;
        postedMarket =
          typeof body === 'object' && body !== null && 'ordType' in body && (body as { ordType?: unknown }).ordType === 'market';
        return json(200, ack());
      }
      // The fetch after a base-sized market buy reports tgtCcy base_ccy, so sz and accFillSz stay one unit.
      return json(200, {
        code: '0',
        msg: '',
        data: [okxOrder('live', postedMarket ? { ordType: 'market', px: '', tgtCcy: 'base_ccy' } : {})],
      });
    });
    const trade = new OkxSpotTrade(KEYS, { http, restBase: 'https://www.okx.com', clock: CLOCK, snapshotLimit: 5 });
    const amount = parseAmount('0.25');
    const marketOrder = await trade.placeOrder({
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'market',
      amount,
      clientOrderId: 'abc',
    });
    expect(marketOrder.type).toBe('market');
    expect(marketOrder.price).toBeNull();
    const marketBody = http.calls.find((call) => call.method === 'POST')!.init?.jsonBody;
    expect(marketBody).toEqual({
      instId: 'BTC-USDT',
      tdMode: 'cash',
      clOrdId: 'abc',
      side: 'buy',
      ordType: 'market',
      sz: formatAmount(amount),
      tgtCcy: 'base_ccy',
    });

    await trade.placeOrder(PLACE);
    const limitBody = http.calls.filter((call) => call.method === 'POST').at(-1)!.init?.jsonBody;
    expect(limitBody).toEqual({
      instId: 'BTC-USDT',
      tdMode: 'cash',
      clOrdId: 'abc',
      side: 'buy',
      ordType: 'limit',
      sz: formatAmount(PLACE.amount),
      px: formatAmount(PLACE.price),
    });
  });

  it('refuses a market order with postOnly before a request is sent', async () => {
    const http = new FakeHttp((url, method) => {
      if (url.includes('/api/v5/market/books')) return json(200, thickBook());
      if (method === 'POST') return json(200, ack());
      return json(200, {
        code: '0',
        msg: '',
        data: [okxOrder('live', { ordType: 'market', px: '', tgtCcy: 'base_ccy' })],
      });
    });
    const trade = new OkxSpotTrade(KEYS, { http, restBase: 'https://www.okx.com', clock: CLOCK, snapshotLimit: 5 });
    let sent: unknown;
    try {
      await trade.placeOrder({
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'market',
        amount: parseAmount('0.25'),
        postOnly: true,
        clientOrderId: 'abc',
      });
      sent = http.calls.find((call) => call.method === 'POST')?.init?.jsonBody;
    } catch (error) {
      expect(error).toBeInstanceOf(VenueUnavailableError);
      expect((error as VenueUnavailableError).venueId).toBe('okx-spot');
      expect((error as VenueUnavailableError).reason).toBe('malformed');
      expect(String((error as Error).message)).toMatch(/postOnly/);
      expect(http.calls).toHaveLength(0);
      expect(http.calls.some((call) => call.url.includes('/api/v5/trade/order'))).toBe(false);
      return;
    }
    const body = sent as { ordType?: unknown } | undefined;
    expect.unreachable(`market postOnly was sent as ordType ${String(body?.ordType ?? '(unset)')}`);
  });

  it('sends a post-only limit as ordType post_only', async () => {
    const http = new FakeHttp((url, method) => {
      if (url.includes('/api/v5/market/books')) return json(200, thickBook());
      if (method === 'POST') return json(200, ack());
      return json(200, { code: '0', msg: '', data: [okxOrder('live')] });
    });
    const trade = new OkxSpotTrade(KEYS, { http, restBase: 'https://www.okx.com', clock: CLOCK, snapshotLimit: 5 });
    const placed = await trade.placeOrder({ ...PLACE, postOnly: true });
    expect(placed.status).toBe('open');
    expect(placed.side).toBe('buy');
    expect(placed.type).toBe('limit');
    expect(formatAmount(placed.price!)).toBe('30000');
    const body = http.calls.find((call) => call.method === 'POST')!.init?.jsonBody;
    expect(body).toEqual({
      instId: 'BTC-USDT',
      tdMode: 'cash',
      clOrdId: 'abc',
      side: 'buy',
      ordType: 'post_only',
      sz: formatAmount(PLACE.amount),
      px: formatAmount(PLACE.price),
    });
  });

  it('code !== "0" throws and never returns a rejected fill', async () => {
    const http = new FakeHttp((url, method) => {
      if (url.includes('/api/v5/market/books')) return json(200, thickBook());
      return json(200, { code: '51000', msg: 'Account error', data: [] });
    });
    const trade = new OkxSpotTrade(KEYS, { http, clock: CLOCK, snapshotLimit: 5 });
    await expect(trade.placeOrder(PLACE)).rejects.toBeInstanceOf(VenueUnavailableError);
    await expect(trade.placeOrder(PLACE)).rejects.toMatchObject({
      reason: 'not_ready',
      message: expect.stringMatching(/51000/),
    });
  });

  it('maps body code 50011 to rate_limited', async () => {
    const http = new FakeHttp(() => json(200, { code: '50011', msg: 'Rate limit reached', data: [] }));
    const trade = new OkxSpotTrade(KEYS, { http, clock: CLOCK });
    await expect(trade.fetchOrder('BTC/USDT', 'abc')).rejects.toMatchObject({
      reason: 'rate_limited',
      message: expect.stringMatching(/50011/),
    });
  });

  it('maps known states and throws malformed on unknown', async () => {
    const http = new FakeHttp((_url, method) => {
      if (method === 'POST') return json(200, ack());
      return json(200, { code: '0', msg: '', data: [okxOrder('filled', { accFillSz: '1', avgPx: '30000' })] });
    });
    const filled = await new OkxSpotTrade(KEYS, { http, clock: CLOCK }).fetchOrder('BTC/USDT', 'abc');
    expect(filled.status).toBe('filled');
    expect(formatAmount(filled.filled)).toBe('1');
    expect(formatAmount(filled.remaining)).toBe('0');
    expect(formatAmount(filled.averagePrice!)).toBe('30000');

    const partialHole = new FakeHttp(() =>
      json(200, { code: '0', msg: '', data: [okxOrder('partially_filled', { accFillSz: '0.4' })] }),
    );
    await expect(new OkxSpotTrade(KEYS, { http: partialHole, clock: CLOCK }).fetchOrder('BTC/USDT', 'abc')).rejects.toMatchObject({
      reason: 'malformed',
      message: expect.stringMatching(/avgPx/),
    });

    const partial = new FakeHttp(() =>
      json(200, { code: '0', msg: '', data: [okxOrder('partially_filled', { accFillSz: '0.4', avgPx: '29950.5' })] }),
    );
    const partialOrder = await new OkxSpotTrade(KEYS, { http: partial, clock: CLOCK }).fetchOrder('BTC/USDT', 'abc');
    expect(partialOrder.status).toBe('partially_filled');
    expect(formatAmount(partialOrder.filled)).toBe('0.4');
    expect(formatAmount(partialOrder.averagePrice!)).toBe('29950.5');

    const canceled = new FakeHttp((_url, method) => {
      if (method === 'POST') return json(200, ack());
      return json(200, { code: '0', msg: '', data: [okxOrder('canceled')] });
    });
    const cancelled = await new OkxSpotTrade(KEYS, { http: canceled, clock: CLOCK }).cancelOrder('BTC/USDT', 'abc');
    expect(cancelled.status).toBe('canceled');
    expect(canceled.calls[0]!.url).toContain('/api/v5/trade/cancel-order');

    const unknown = new FakeHttp(() => json(200, { code: '0', msg: '', data: [okxOrder('mmp_canceled')] }));
    await expect(new OkxSpotTrade(KEYS, { http: unknown, clock: CLOCK }).fetchOrder('BTC/USDT', 'abc')).rejects.toMatchObject({
      reason: 'malformed',
    });
  });

  it('refuses a sized partial fill with a blank or zero avgPx, and still reports a real average', () => {
    const now = new Date(CLOCK());
    const blank = okxOrder('partially_filled', { accFillSz: '0.4', avgPx: '' });
    const zero = okxOrder('partially_filled', { accFillSz: '0.4', avgPx: '0' });
    const zeroScale = okxOrder('partially_filled', { accFillSz: '0.4', avgPx: '0.00' });
    const missingAvg = okxOrder('partially_filled', { accFillSz: '0.4', avgPx: undefined });
    for (const row of [blank, zero, zeroScale, missingAvg]) {
      let published = false;
      try {
        mapOkxSpotOrder(row, 'BTC/USDT', now);
        published = true;
      } catch (error) {
        expect(error).toBeInstanceOf(VenueUnavailableError);
        expect((error as VenueUnavailableError).venueId).toBe('okx-spot');
        expect((error as VenueUnavailableError).reason).toBe('malformed');
        expect(String((error as Error).message)).toMatch(/avgPx/);
      }
      if (published) expect.unreachable('a sized partial fill with no average price was published');
    }

    const priced = mapOkxSpotOrder(
      okxOrder('partially_filled', { accFillSz: '0.4', avgPx: '29950.5' }),
      'BTC/USDT',
      now,
    );
    expect(priced.status).toBe('partially_filled');
    expect(formatAmount(priced.averagePrice!)).toBe('29950.5');
    expect(formatAmount(priced.price!)).toBe('30000');
  });

  it('refuses a non-market order with a blank or zero px instead of returning price null', () => {
    const now = new Date(CLOCK());
    for (const px of ['', '0', '0.0', '0.00']) {
      let published: string | null | undefined;
      try {
        const order = mapOkxSpotOrder(okxOrder('live', { px }), 'BTC/USDT', now);
        published = order.price === null ? null : formatAmount(order.price);
      } catch (error) {
        expect(error).toBeInstanceOf(VenueUnavailableError);
        expect((error as VenueUnavailableError).reason).toBe('malformed');
        expect(String((error as Error).message)).toMatch(/px/);
        continue;
      }
      expect.unreachable(`blank or zero px was published as ${published === null ? 'null' : published}`);
    }
  });

  it('refuses an ordType other than market or limit instead of publishing it as a limit', () => {
    const now = new Date(CLOCK());
    for (const ordType of ['', 'iceberg', 'fok', 'ioc']) {
      let published: string | undefined;
      try {
        published = mapOkxSpotOrder(okxOrder('live', { ordType }), 'BTC/USDT', now).type;
      } catch (error) {
        expect(error).toBeInstanceOf(VenueUnavailableError);
        expect((error as VenueUnavailableError).reason).toBe('malformed');
        expect(String((error as Error).message)).toMatch(/ordType/);
        continue;
      }
      expect.unreachable(`ordType ${ordType || '(empty)'} was published as ${published}`);
    }

    const limit = mapOkxSpotOrder(okxOrder('live'), 'BTC/USDT', now);
    expect(limit.type).toBe('limit');
    expect(formatAmount(limit.price!)).toBe('30000');
    const market = mapOkxSpotOrder(okxOrder('live', { ordType: 'market', px: '', tgtCcy: 'base_ccy' }), 'BTC/USDT', now);
    expect(market.type).toBe('market');
    expect(market.price).toBeNull();
  });

  it('refuses a missing, blank, or unknown side instead of reporting it as buy', () => {
    const now = new Date(CLOCK());
    const missing: Record<string, unknown> = { ...okxOrder('live') };
    delete missing.side;
    const cases: ReadonlyArray<{ label: string; row: Record<string, unknown> }> = [
      { label: 'missing', row: missing },
      { label: 'undefined', row: okxOrder('live', { side: undefined }) },
      { label: 'null', row: okxOrder('live', { side: null }) },
      { label: 'blank', row: okxOrder('live', { side: '' }) },
      { label: 'blank whitespace', row: okxOrder('live', { side: '   ' }) },
      { label: 'unknown', row: okxOrder('live', { side: 'hold' }) },
    ];
    for (const { label, row } of cases) {
      let published: string | undefined;
      try {
        published = mapOkxSpotOrder(row, 'BTC/USDT', now).side;
      } catch (error) {
        expect(error).toBeInstanceOf(VenueUnavailableError);
        expect((error as VenueUnavailableError).venueId).toBe('okx-spot');
        expect((error as VenueUnavailableError).reason).toBe('malformed');
        expect(String((error as Error).message)).toMatch(/side/);
        continue;
      }
      expect.unreachable(`${label} side was published as ${published}`);
    }

    const buy = mapOkxSpotOrder(okxOrder('live', { side: 'buy' }), 'BTC/USDT', now);
    expect(buy.side).toBe('buy');
    expect(formatAmount(buy.price!)).toBe('30000');
    const sell = mapOkxSpotOrder(okxOrder('live', { side: 'sell' }), 'BTC/USDT', now);
    expect(sell.side).toBe('sell');
    expect(formatAmount(sell.price!)).toBe('30000');
    expect(mapOkxSpotOrder(okxOrder('live', { side: 'Buy' }), 'BTC/USDT', now).side).toBe('buy');
    expect(mapOkxSpotOrder(okxOrder('live', { side: 'SELL' }), 'BTC/USDT', now).side).toBe('sell');
  });

  it('openOrders GETs orders-pending and maps live rows', async () => {
    const http = new FakeHttp(() =>
      json(200, { code: '0', msg: '', data: [okxOrder('live'), okxOrder('live', { clOrdId: 'def', ordId: '2' })] }),
    );
    const trade = new OkxSpotTrade(KEYS, { http, clock: CLOCK });
    const open = await trade.openOrders('BTC/USDT');
    expect(open).toHaveLength(2);
    expect(open[0]!.status).toBe('open');
    expect(http.calls[0]!.method).toBe('GET');
    expect(http.calls[0]!.url).toContain('/api/v5/trade/orders-pending?instType=SPOT&instId=BTC-USDT');
    expect(http.calls[0]!.init?.headers?.['OK-ACCESS-SIGN']).toBeTruthy();
  });

  it('refuses when POST is not wired', async () => {
    const getOnly: HttpPort = {
      async get() {
        return json(200, thickBook());
      },
    };
    const trade = new OkxSpotTrade(KEYS, { http: getOnly, clock: CLOCK, snapshotLimit: 5 });
    await expect(trade.placeOrder(PLACE)).rejects.toMatchObject({
      reason: 'not_ready',
      message: expect.stringMatching(/POST/),
    });
  });
});

describe('okx-spot — signed account observation (FakeHttp, no live network)', () => {
  it('balances GETs /api/v5/account/balance with OK-ACCESS-SIGN and maps details', async () => {
    const http = new FakeHttp(() =>
      json(200, {
        code: '0',
        msg: '',
        data: [
          {
            details: [
              { ccy: 'USDT', availBal: '90', frozenBal: '10', eq: '100' },
              { ccy: 'BTC', availBal: '1', frozenBal: '0', eq: '1' },
            ],
          },
        ],
      }),
    );
    const account = new OkxSpotAccount(KEYS, { http, clock: CLOCK });
    const rows = await account.balances();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.asset).toBe('USDT');
    expect(formatAmount(rows[0]!.free)).toBe('90');
    expect(formatAmount(rows[0]!.used)).toBe('10');
    expect(formatAmount(rows[0]!.total)).toBe('100');
    expect(http.calls[0]!.method).toBe('GET');
    expect(http.calls[0]!.url).toBe('https://www.okx.com/api/v5/account/balance');
    expect(http.calls[0]!.init?.headers?.['OK-ACCESS-SIGN']).toBeTruthy();
  });

  it('spot positions is [] — honest empty, not not_ready', async () => {
    expect(await new OkxSpotAccount(KEYS, { http: new FakeHttp(() => json(200, {})) }).positions()).toEqual([]);
  });

  it('transferRails stays not_ready — wallet permission refused', async () => {
    await expect(new OkxSpotAccount(KEYS).transferRails()).rejects.toMatchObject({ reason: 'not_ready' });
  });
});
