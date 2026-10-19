import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatAmount } from '@intafaced/ledger-client/money';
import { VenueCapabilityError, VenueCredentialsMissingError, VenueUnavailableError } from '@intafaced/venue-contracts';
import {
  BYBIT_IP_BACKOFF_MS,
  BybitSpotAccount,
  BybitSpotMarketData,
  BybitSpotTrade,
  bybitSymbolOf,
  subscribeRefusal,
  takerSideOf,
} from './bybit-spot.js';
import { bybitSymbolFilters, bybitTakerCommissionRate } from './bybit-spot-trade.js';
import { AsyncFrameQueue, type HttpPort, type HttpResponse, type StreamHandle, type StreamPort } from '../transport.js';
import { MaintainedBook } from '../book-feed.js';
import { RateLimitGovernor } from '../rate-limit.js';

// ════════════════════════════════════════════════════════════════════════════
// FAKE TRANSPORT
//
// Fixtures, never the live venue. Not only because §27 has no live-network CI:
// the cases worth testing here are the ones a healthy venue never produces on
// demand — a rate-limit verdict hidden inside an HTTP 200, a subscribe rejection
// that arrives with `success: true`, a feed that restarts and renumbers itself
// mid-stream. You cannot ask Bybit for any of them.
// ════════════════════════════════════════════════════════════════════════════

class FakeHttp implements HttpPort {
  readonly requests: string[] = [];
  readonly posts: { url: string; jsonBody?: unknown; headers?: Readonly<Record<string, string>> }[] = [];
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

  async post(url: string, init?: { jsonBody?: unknown; headers?: Readonly<Record<string, string>> }): Promise<HttpResponse> {
    this.requests.push(`POST ${url}`);
    this.posts.push({ url, jsonBody: init?.jsonBody, headers: init?.headers });
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
  readonly frames: unknown[][] = [];
  closed = 0;

  async open(url: string): Promise<StreamHandle> {
    this.opened.push(url);
    const queue = new AsyncFrameQueue<unknown>();
    this.queues.push(queue);
    const sent: unknown[] = [];
    this.frames.push(sent);
    return {
      messages: queue,
      // Recorded synchronously, so a test can assert what went out without
      // needing the microtask queue to drain first.
      send: async (payload: unknown) => {
        sent.push(payload);
      },
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

  /** What we sent on the Nth socket — subscribe first, then heartbeats. */
  sent(index = 0): unknown[] {
    return this.frames[index]!;
  }
}

/** A transport that cannot speak. Bybit subscribes by message, so this must be refused. */
const receiveOnlyStream: StreamPort = {
  async open() {
    return { messages: new AsyncFrameQueue<unknown>(), close: async () => undefined };
  },
};

// ── Fixtures, shaped exactly as the venue documents them ─────────────────────

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

/** `GET /v5/market/orderbook` — every price and size a decimal STRING, `u` an integer. */
const orderbook = (u: number, over: { b?: [string, string][]; a?: [string, string][] } = {}): unknown => ({
  retCode: 0,
  retMsg: 'OK',
  result: {
    s: 'BTCUSDT',
    b: over.b ?? LEVELS.b,
    a: over.a ?? LEVELS.a,
    ts: 1_700_000_000_000,
    u,
    seq: 9_000 + u,
    cts: 1_700_000_000_000,
  },
  retExtInfo: {},
  time: 1_700_000_000_000,
});

const depthFrame = (type: 'snapshot' | 'delta', u: number, over: { b?: [string, string][]; a?: [string, string][] } = {}): unknown => ({
  topic: 'orderbook.50.BTCUSDT',
  type,
  ts: 1,
  data: { s: 'BTCUSDT', b: over.b ?? [], a: over.a ?? [], u, seq: 9_000 + u },
  cts: 1,
});

function adapter(http: FakeHttp, stream: FakeStream, clock: () => number = () => 1_000_000) {
  return new BybitSpotMarketData({
    http,
    stream,
    clock,
    restBase: 'https://rest.test',
    wsBase: 'wss://ws.test/v5/public/spot',
    // The heartbeat has its own test. Off here so no suite leaks an interval.
    heartbeatMs: 0,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

// ════════════════════════════════════════════════════════════════════════════

describe('symbol mapping', () => {
  it('speaks the venue spelling only when talking to the venue', () => {
    expect(bybitSymbolOf('BTC/USDT')).toBe('BTCUSDT');
    expect(bybitSymbolOf('BTC/USD:BTC')).toBe('BTCUSDBTC');
  });
});

describe('BybitSpotMarketData.snapshotBook — public data, no credentials', () => {
  it('reads a snapshot with our clock, not the venue’s, and carries `u` as the sequence', async () => {
    const http = new FakeHttp().queue(orderbook(4_242));
    const snapshot = await adapter(http, new FakeStream(), () => 1_700_000_000_001).snapshotBook('BTC/USDT', 50);

    // `u`, not `seq` (9242 in the fixture): `seq` is a cross-topic ordering hint
    // and cannot be gap-checked. Picking the wrong one would look fine here and
    // desync the tracker in production.
    expect(snapshot.sequence).toBe(4_242);
    expect(snapshot.sequenced).toBe(true);
    expect(snapshot.venueId).toBe('bybit-spot');
    expect(snapshot.observedAt.getTime()).toBe(1_700_000_000_001);
    expect(formatAmount(snapshot.bids[0]![0])).toBe('30000');
    expect(formatAmount(snapshot.asks[0]![1])).toBe('1');
    expect(http.requests[0]).toBe('https://rest.test/v5/market/orderbook?category=spot&symbol=BTCUSDT&limit=50');
  });

  it('caps the depth limit rather than spending a request the venue will reject', async () => {
    const http = new FakeHttp().queue(orderbook(1));
    await adapter(http, new FakeStream()).snapshotBook('BTC/USDT', 999_999);
    expect(http.requests[0]).toContain('limit=1000');
  });

  /**
   * Omitted depth is unpublished — never a git-default 200, and never the
   * venue's own one-level default (which would look like a thin market).
   */
  it('refuses an unpublished limit rather than inventing 200', async () => {
    const http = new FakeHttp().queue(orderbook(1));
    await expect(adapter(http, new FakeStream()).snapshotBook('BTC/USDT')).rejects.toMatchObject({
      name: 'SnapshotBookLimitUnsetError',
      code: 'venue.snapshot_book.limit_unset',
    });
    expect(http.requests).toHaveLength(0);
  });

  /**
   * THE ONE THING EVERY OTHER TEST HERE HIDES.
   *
   * Every case above injects `restBase`/`wsBase`, so a typo in the adapter's own
   * default host would be invisible in all of them — and invisible in production
   * too until the first request 404s or DNS fails. These two fake only the
   * transport and let the adapter choose the address.
   */
  it('addresses the venue’s real REST host when none is injected', async () => {
    const http = new FakeHttp().queue(orderbook(1));
    await new BybitSpotMarketData({ http, heartbeatMs: 0 }).snapshotBook('BTC/USDT', 1);
    expect(http.requests[0]).toBe('https://api.bybit.com/v5/market/orderbook?category=spot&symbol=BTCUSDT&limit=1');
  });

  it('opens the venue’s real spot websocket when none is injected', async () => {
    const stream = new FakeStream();
    const subscription = await new BybitSpotMarketData({ http: new FakeHttp(), stream, heartbeatMs: 0 }).streamBook('BTC/USDT');
    expect(stream.opened).toEqual(['wss://stream.bybit.com/v5/public/spot']);
    await subscription.close();
  });

  it('sorts levels away from the spread even when the venue sends them jumbled', async () => {
    const http = new FakeHttp().queue(
      orderbook(1, {
        b: [
          ['29999.00', '5.00'],
          ['30000.00', '2.00'],
        ],
        a: [
          ['30003.00', '4.00'],
          ['30002.00', '1.00'],
        ],
      }),
    );
    const snapshot = await adapter(http, new FakeStream()).snapshotBook('BTC/USDT', 1);
    expect(formatAmount(snapshot.bids[0]![0])).toBe('30000');
    expect(formatAmount(snapshot.asks[0]![0])).toBe('30002');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// REFUSALS — one test per way this venue can fail to give us a book.
//
// The adapter's contract is the FIRST venue's, unchanged: `snapshotBook` throws
// `VenueUnavailableError` with a typed reason. The `null` that the mark path
// needs is produced by `markSourceFromVenuePublicBook` catching exactly these —
// asserted end to end in svc-trade's `mark-from-venue.test.ts`, through the real
// adapter, because a refusal that is correct here and unreachable there is the
// failure mode this repo keeps producing.
// ════════════════════════════════════════════════════════════════════════════

describe('refusals — never a book we cannot stand behind', () => {
  it('EMPTY book: reports it empty, and does not invent a level', async () => {
    const http = new FakeHttp().queue(orderbook(7, { b: [], a: [] }));
    const snapshot = await adapter(http, new FakeStream()).snapshotBook('BTC/USDT', 1);
    expect(snapshot.bids).toEqual([]);
    expect(snapshot.asks).toEqual([]);
    // Still a real, sequenced read of a real market. "No liquidity" is a fact,
    // not an error, and the caller is the one that must refuse to price it.
    expect(snapshot.sequence).toBe(7);
  });

  it('ONE-SIDED book: keeps the side that exists and leaves the other empty', async () => {
    const http = new FakeHttp().queue(orderbook(8, { a: [] }));
    const snapshot = await adapter(http, new FakeStream()).snapshotBook('BTC/USDT', 1);
    expect(snapshot.bids).toHaveLength(2);
    expect(snapshot.asks).toEqual([]);
  });

  it('TWO-SIDED DUST book: refused as no_depth — not a mid-able quote (D26-P1-T8)', async () => {
    const http = new FakeHttp().queue(
      orderbook(9, {
        b: [['30000.00', '0.00000001']],
        a: [['30002.00', '0.00000001']],
      }),
    );
    const md = adapter(http, new FakeStream());
    try {
      await md.snapshotBook('BTC/USDT', 1);
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(VenueUnavailableError);
      expect((error as VenueUnavailableError).reason).toBe('no_depth');
      expect((error as VenueUnavailableError).message).toMatch(/not payout-grade/);
    }
  });

  it('UNKNOWN market id: a non-zero retCode is refused as not_ready, never as an empty book', async () => {
    const http = new FakeHttp().queue({ retCode: 10_001, retMsg: 'Not supported symbols', result: {}, time: 1 });
    const md = adapter(http, new FakeStream());

    try {
      await md.snapshotBook('NOPE/USDT', 1);
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(VenueUnavailableError);
      // An empty book would be indistinguishable from a market with no
      // liquidity, and a mark built on that reads as a real (absent) quote.
      expect((error as VenueUnavailableError).reason).toBe('not_ready');
      expect((error as VenueUnavailableError).message).toContain('10001');
      expect((error as VenueUnavailableError).message).toContain('Not supported symbols');
    }
  });

  it('a venue rejection is graded a REJECT, not an outage — our typo is not their downtime', async () => {
    const http = new FakeHttp().queue({ retCode: 10_001, retMsg: 'Not supported symbols', result: {}, time: 1 });
    const md = new BybitSpotMarketData({ http, stream: new FakeStream(), clock: () => 0, heartbeatMs: 0 });
    await expect(md.snapshotBook('NOPE/USDT', 1)).rejects.toThrow(VenueUnavailableError);
    expect(md.grader.grade(new Date(0)).rejectRateBps).toBe(10_000);
    expect(md.grader.grade(new Date(0)).errorRateBps).toBe(0);
  });

  it('MALFORMED: a payload that has started arriving as JSON numbers is refused at the wire', async () => {
    const http = new FakeHttp().queue({
      retCode: 0,
      retMsg: 'OK',
      result: { s: 'BTCUSDT', b: [[30000, 2]], a: [], ts: 1, u: 1, seq: 1 },
      time: 1,
    });
    await expect(adapter(http, new FakeStream()).snapshotBook('BTC/USDT', 1)).rejects.toThrow(/JSON number/);
  });

  it('MALFORMED: a 200 with no numeric retCode is refused rather than read as success', async () => {
    const http = new FakeHttp().queue({ result: { b: [], a: [], u: 1 } });
    await expect(adapter(http, new FakeStream()).snapshotBook('BTC/USDT', 1)).rejects.toThrow(/no numeric retCode/);
  });

  it('MALFORMED: retCode 0 with no result object is refused', async () => {
    const http = new FakeHttp().queue({ retCode: 0, retMsg: 'OK', result: null, time: 1 });
    await expect(adapter(http, new FakeStream()).snapshotBook('BTC/USDT', 1)).rejects.toThrow(/no result object/);
  });

  it('MALFORMED: a side that is not an array is refused', async () => {
    const http = new FakeHttp().queue({ retCode: 0, retMsg: 'OK', result: { b: 'nope', a: [], u: 1 }, time: 1 });
    await expect(adapter(http, new FakeStream()).snapshotBook('BTC/USDT', 1)).rejects.toThrow(/is not an array/);
  });

  it('MALFORMED: a missing update id is refused rather than defaulted', async () => {
    // `Number(undefined)` is NaN and `Number(null)` is 0 — a sequence of zero
    // would be a plausible first sequence and defeat every gap check downstream.
    const http = new FakeHttp().queue({ retCode: 0, retMsg: 'OK', result: { b: [], a: [] }, time: 1 });
    await expect(adapter(http, new FakeStream()).snapshotBook('BTC/USDT', 1)).rejects.toThrow(/orderbook\.u/);
  });

  it('MALFORMED: a non-positive price refuses the WHOLE response, not just the level', async () => {
    const http = new FakeHttp().queue({
      retCode: 0,
      retMsg: 'OK',
      result: { s: 'BTCUSDT', b: [['0', '2.00']], a: [], ts: 1, u: 1, seq: 1 },
      time: 1,
    });
    await expect(adapter(http, new FakeStream()).snapshotBook('BTC/USDT', 1)).rejects.toThrow(/non-positive price/);
  });

  it('UNREACHABLE: a transport failure is reported as unreachable and graded an error', async () => {
    const md = new BybitSpotMarketData({
      http: {
        get: async () => {
          throw new Error('ECONNRESET');
        },
      },
      stream: new FakeStream(),
      clock: () => 0,
      heartbeatMs: 0,
    });
    await expect(md.snapshotBook('BTC/USDT', 1)).rejects.toThrow(/ECONNRESET/);
    expect(md.grader.grade(new Date(0)).errorRateBps).toBe(10_000);
  });

  it('UNREACHABLE: a 5xx is not a book', async () => {
    const http = new FakeHttp().queue(null, 503);
    await expect(adapter(http, new FakeStream()).snapshotBook('BTC/USDT', 1)).rejects.toThrow(/answered 503/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// RATE GOVERNING — including the verdict that hides inside a 200
// ════════════════════════════════════════════════════════════════════════════

describe('rate governing on the REST path', () => {
  it('spends one slot per request, because this venue counts requests and not weight', async () => {
    const governor = new RateLimitGovernor({ venueId: 'bybit-spot', capacity: 2, windowMs: 5_000, reservedHeadroomBps: 0 }, 0);
    const http = new FakeHttp().queue(orderbook(1)).queue(orderbook(2));
    const md = new BybitSpotMarketData({
      http,
      stream: new FakeStream(),
      governor,
      clock: () => 0,
      restBase: 'https://rest.test',
      heartbeatMs: 0,
    });

    // Two fit in a two-slot bucket regardless of depth; the third does not.
    await md.snapshotBook('BTC/USDT', 1_000);
    await md.snapshotBook('BTC/USDT', 1);
    await expect(md.snapshotBook('BTC/USDT', 1)).rejects.toThrow(/retry in/);
  });

  it('excludes and REPORTS as rate_limited rather than waiting silently', async () => {
    const governor = new RateLimitGovernor({ venueId: 'bybit-spot', capacity: 1, windowMs: 5_000, reservedHeadroomBps: 0 }, 0);
    const md = new BybitSpotMarketData({ http: new FakeHttp(), stream: new FakeStream(), governor, clock: () => 0, heartbeatMs: 0 });

    await md.snapshotBook('BTC/USDT', 1).catch(() => undefined);
    try {
      await md.snapshotBook('BTC/USDT', 1);
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(VenueUnavailableError);
      expect((error as VenueUnavailableError).reason).toBe('rate_limited');
    }
  });

  it('believes a 403 over its own arithmetic and holds off for the documented ten minutes', async () => {
    let now = 0;
    const http = new FakeHttp().queue({ retCode: 10_018, retMsg: 'access too frequent' }, 403).queue(orderbook(1));
    const md = new BybitSpotMarketData({ http, stream: new FakeStream(), clock: () => now, restBase: 'https://rest.test', heartbeatMs: 0 });

    await expect(md.snapshotBook('BTC/USDT', 1)).rejects.toThrow(/answered 403/);

    // Plenty of slots left by our count. The venue said stop, so we stop — and
    // with no Retry-After to read, the floor is the venue's own instruction.
    now = 1_000;
    await expect(md.snapshotBook('BTC/USDT', 1)).rejects.toThrow(/told us to back off/);
    expect(md.governor.backoffUntil(now)).toBe(BYBIT_IP_BACKOFF_MS);
    expect(BYBIT_IP_BACKOFF_MS).toBe(600_000);

    // Only one request actually reached the transport.
    expect(http.requests).toHaveLength(1);
  });

  /**
   * THE DIFFERENCE FROM THE FIRST VENUE, IN ONE ASSERTION.
   *
   * Binance says "slow down" in the status line. Bybit says it in the BODY of a
   * response the status line calls a success. An adapter that only read
   * `response.status` — which is the obvious implementation, and the one the
   * first venue's shape suggests — would see a 200, see no book, retry, and be
   * IP-banned inside a minute.
   */
  it('reads the rate-limit verdict out of an HTTP 200 and backs off anyway', async () => {
    const http = new FakeHttp().queue({ retCode: 10_006, retMsg: 'Too many visits!', result: {}, time: 1 }, 200);
    const md = new BybitSpotMarketData({ http, stream: new FakeStream(), clock: () => 0, heartbeatMs: 0 });

    try {
      await md.snapshotBook('BTC/USDT', 1);
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as VenueUnavailableError).reason).toBe('rate_limited');
      expect((error as VenueUnavailableError).message).toContain('inside an HTTP 200');
    }
    expect(md.governor.backoffUntil(0)).toBe(BYBIT_IP_BACKOFF_MS);
  });

  it('records a successful read on the latency grader', async () => {
    let now = 0;
    const http = new FakeHttp().queue(orderbook(1));
    const md = new BybitSpotMarketData({
      http: {
        get: async (url) => {
          now += 31;
          return http.get(url);
        },
      },
      stream: new FakeStream(),
      clock: () => now,
      heartbeatMs: 0,
    });

    await md.snapshotBook('BTC/USDT', 1);
    const grade = md.grader.grade(new Date(now));
    expect(grade.samples).toBe(1);
    expect(grade.p95Ms).toBe(31);
    // One sample is not a grade. It says so — which is the whole point of having
    // a second venue to rank against.
    expect(grade.provisional).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MARKETS
// ════════════════════════════════════════════════════════════════════════════

describe('BybitSpotMarketData.markets', () => {
  const instruments = (over: Record<string, unknown> = {}): unknown => ({
    retCode: 0,
    retMsg: 'OK',
    result: {
      category: 'spot',
      list: [
        {
          symbol: 'BTCUSDT',
          baseCoin: 'BTC',
          quoteCoin: 'USDT',
          status: 'Trading',
          lotSizeFilter: {
            basePrecision: '0.000001',
            quotePrecision: '0.00000001',
            minOrderQty: '0.000048',
            maxOrderQty: '71.73956243',
            minOrderAmt: '1',
            maxLimitOrderQty: '80',
          },
          priceFilter: { tickSize: '0.01' },
        },
        {
          symbol: 'DEADUSDT',
          baseCoin: 'DEAD',
          quoteCoin: 'USDT',
          status: 'Delivering',
          lotSizeFilter: {},
          priceFilter: {},
        },
      ],
      nextPageCursor: '',
      ...over,
    },
    time: 1,
  });

  it('normalises spot markets, with the tick as a SIZE and fees marked indicative', async () => {
    const http = new FakeHttp().queue(instruments());
    const markets = await adapter(http, new FakeStream()).markets();

    expect(http.requests[0]).toBe('https://rest.test/v5/market/instruments-info?category=spot');
    expect(markets).toHaveLength(2);

    const btc = markets[0]!;
    expect(btc.venueId).toBe('bybit-spot');
    expect(btc.symbol).toBe('BTC/USDT');
    expect(btc.venueSymbol).toBe('BTCUSDT');
    expect(btc.type).toBe('spot');
    expect(btc.settle).toBeNull();
    expect(btc.active).toBe(true);
    expect(formatAmount(btc.precision.price)).toBe('0.01');
    expect(formatAmount(btc.precision.amount)).toBe('0.000001');
    expect(formatAmount(btc.limits.minCost)).toBe('1');
    expect(formatAmount(btc.limits.minAmount)).toBe('0.000048');
    // The non-deprecated ceiling wins over `maxOrderQty`.
    expect(formatAmount(btc.limits.maxAmount!)).toBe('80');
    // Published defaults, not this account's rates — the flag travels with them.
    expect(btc.fees).toEqual({ makerBps: 10, takerBps: 10, indicative: true });
  });

  it('marks a non-Trading market inactive rather than dropping it', async () => {
    const http = new FakeHttp().queue(instruments());
    const markets = await adapter(http, new FakeStream()).markets();
    // Dropped, a caller cannot say WHY there is no liquidity — only that a
    // symbol it expected is missing, which looks like our bug.
    expect(markets[1]!.active).toBe(false);
    expect(markets[1]!.limits.maxAmount).toBeNull();
  });

  /**
   * Spot is documented as unpaginated, and this adapter relies on that. Checking
   * it is the difference between relying on a documented fact and assuming one: a
   * page returned as the universe reads as a mass delisting, and every market
   * past the cut looks absent rather than unread.
   */
  it('REFUSES a truncated market list rather than reporting a page as the universe', async () => {
    const http = new FakeHttp().queue(instruments({ nextPageCursor: 'page-2' }));
    await expect(adapter(http, new FakeStream()).markets()).rejects.toThrow(/TRUNCATED/);
  });

  it('refuses a response with no list array', async () => {
    const http = new FakeHttp().queue({ retCode: 0, retMsg: 'OK', result: { category: 'spot' }, time: 1 });
    await expect(adapter(http, new FakeStream()).markets()).rejects.toThrow(/no list array/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE WEBSOCKET — subscribing by message, and the two ways that goes wrong
// ════════════════════════════════════════════════════════════════════════════

describe('streamBook — subscribe by message, not by URL', () => {
  it('opens one socket and SENDS the subscription', async () => {
    const stream = new FakeStream();
    const subscription = await adapter(new FakeHttp(), stream).streamBook('BTC/USDT');

    expect(stream.opened).toEqual(['wss://ws.test/v5/public/spot']);
    expect(stream.sent()).toEqual([{ op: 'subscribe', args: ['orderbook.50.BTCUSDT'] }]);

    await subscription.close();
  });

  /**
   * A socket we opened and never subscribed on is open, healthy and permanently
   * silent — indistinguishable, in every metric this fabric has, from a market
   * with no activity. So a transport that cannot speak is refused at the door
   * rather than handed back as a subscription that will never yield a frame.
   */
  it('REFUSES a receive-only transport instead of returning a silent subscription', async () => {
    const md = new BybitSpotMarketData({ http: new FakeHttp(), stream: receiveOnlyStream, heartbeatMs: 0 });
    await expect(md.streamBook('BTC/USDT')).rejects.toThrow(VenueCapabilityError);
    await expect(md.streamTrades('BTC/USDT')).rejects.toThrow(/receive-only/);
  });

  it('skips the venue’s seeding snapshot frame — a delta cannot express a removal', async () => {
    const stream = new FakeStream();
    const subscription = await adapter(new FakeHttp(), stream).streamBook('BTC/USDT');

    stream.socket().push(depthFrame('snapshot', 100, { b: [['30000.00', '2.00']] }));
    stream.socket().push(depthFrame('delta', 101, { b: [['30001.00', '3.00']] }));
    stream.socket().close();

    const deltas = [];
    for await (const delta of subscription.deltas) deltas.push(delta);

    // Only the delta. Replaying a full book as absolute levels would leave every
    // level the snapshot omitted sitting in the book as phantom liquidity.
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.sequence).toEqual({ firstSequence: 101, lastSequence: 101 });
    expect(deltas[0]!.bids).toEqual([['30001', '3']]);
    expect(deltas[0]!.venueId).toBe('bybit-spot');
  });

  it('preserves a zero quantity in a delta — it is the only encoding of removal', async () => {
    const stream = new FakeStream();
    const subscription = await adapter(new FakeHttp(), stream).streamBook('BTC/USDT');
    stream.socket().push(depthFrame('delta', 101, { b: [['30000.00', '0']] }));
    stream.socket().close();

    const deltas = [];
    for await (const delta of subscription.deltas) deltas.push(delta);
    expect(deltas[0]!.bids).toEqual([['30000', '0']]);
  });

  it('ignores control chatter — the subscribe ack and the pong are not book frames', async () => {
    const stream = new FakeStream();
    const subscription = await adapter(new FakeHttp(), stream).streamBook('BTC/USDT');

    stream.socket().push({ success: true, ret_msg: '', conn_id: 'c1', req_id: '', op: 'subscribe' });
    stream.socket().push({ success: true, ret_msg: 'pong', conn_id: 'c1', op: 'ping' });
    stream.socket().push({ topic: 'orderbook.50.ETHUSDT', type: 'delta', data: { u: 5, b: [], a: [] } });
    stream.socket().push(depthFrame('delta', 101, { a: [['30002.00', '1.00']] }));
    stream.socket().close();

    const deltas = [];
    for await (const delta of subscription.deltas) deltas.push(delta);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.asks).toEqual([['30002', '1']]);
  });

  /**
   * THE `success: true` REJECTION.
   *
   * Bybit reports a partial subscribe failure with `success: true` and the
   * rejected topics in `data.failTopics`. Checking `success` alone leaves us
   * waiting forever on a topic the venue has already said it will never send —
   * and waiting forever looks exactly like a quiet market.
   */
  it('FAILS the subscription when the venue lists our topic in failTopics, despite success: true', async () => {
    const stream = new FakeStream();
    const subscription = await adapter(new FakeHttp(), stream).streamBook('BTC/USDT');

    stream.socket().push({
      success: true,
      conn_id: 'c1',
      type: 'COMMAND_RESP',
      data: { failTopics: ['orderbook.50.BTCUSDT'], successTopics: [] },
    });

    await expect(async () => {
      for await (const _delta of subscription.deltas) void _delta;
    }).rejects.toThrow(/refused the subscription to orderbook\.50\.BTCUSDT/);
  });

  it('FAILS on a flat success: false rejection too', async () => {
    const stream = new FakeStream();
    const subscription = await adapter(new FakeHttp(), stream).streamBook('BTC/USDT');
    stream.socket().push({ success: false, ret_msg: 'Invalid symbol', op: 'subscribe' });

    await expect(async () => {
      for await (const _delta of subscription.deltas) void _delta;
    }).rejects.toThrow(/Invalid symbol/);
  });

  it('sends the heartbeat the venue requires, on the venue’s cadence', async () => {
    vi.useFakeTimers();
    const stream = new FakeStream();
    const md = new BybitSpotMarketData({
      http: new FakeHttp(),
      stream,
      wsBase: 'wss://ws.test/v5/public/spot',
      heartbeatMs: 20_000,
    });

    const subscription = await md.streamBook('BTC/USDT');
    expect(stream.sent()).toHaveLength(1);

    // Without this the venue closes the connection, and the fabric reads our own
    // missing heartbeat as the venue going away — an outage we caused.
    vi.advanceTimersByTime(20_000);
    expect(stream.sent()[1]).toEqual({ op: 'ping' });
    vi.advanceTimersByTime(20_000);
    expect(stream.sent()[2]).toEqual({ op: 'ping' });

    await subscription.close();
    // Closing stops it. A heartbeat outliving its socket is a leak with a timer.
    vi.advanceTimersByTime(60_000);
    expect(stream.sent()).toHaveLength(3);
  });
});

describe('streamTrades — the aggressor, read straight through', () => {
  it('reads the tape and does NOT invert the taker side', async () => {
    const stream = new FakeStream();
    const subscription = await adapter(new FakeHttp(), stream).streamTrades('BTC/USDT');
    expect(stream.sent()).toEqual([{ op: 'subscribe', args: ['publicTrade.BTCUSDT'] }]);

    // `S` is the side of the TAKER. The first venue's `m` means "buyer is the
    // maker" and has to be inverted; copying that inversion here would flip every
    // volume-side signal built on the tape, with no error anywhere.
    stream.socket().push({
      topic: 'publicTrade.BTCUSDT',
      type: 'snapshot',
      ts: 1,
      data: [
        { i: '77', T: 1_700_000_000_000, p: '30001.50', v: '0.25', S: 'Buy', s: 'BTCUSDT', BT: false },
        { i: '78', T: 1_700_000_000_001, p: '30002.00', v: '0.10', S: 'Sell', s: 'BTCUSDT', BT: false },
      ],
    });
    stream.socket().close();

    const trades = [];
    for await (const trade of subscription.trades) trades.push(trade);

    expect(trades.map((t) => t.takerSide)).toEqual(['buy', 'sell']);
    expect(formatAmount(trades[0]!.price)).toBe('30001.5');
    expect(formatAmount(trades[1]!.amount)).toBe('0.1');
    expect(trades[0]!.tradeId).toBe('77');
    expect(trades[0]!.tradedAt.getTime()).toBe(1_700_000_000_000);
  });

  it('refuses a trade print that arrives as a JSON number', async () => {
    const stream = new FakeStream();
    const subscription = await adapter(new FakeHttp(), stream).streamTrades('BTC/USDT');
    stream.socket().push({ topic: 'publicTrade.BTCUSDT', type: 'snapshot', data: [{ i: '1', T: 1, p: 30_001.5, v: '1', S: 'Buy' }] });

    await expect(async () => {
      for await (const _trade of subscription.trades) void _trade;
    }).rejects.toThrow(/JSON number/);
  });
});

describe('subscribeRefusal / takerSideOf', () => {
  it('reads both refusal shapes, and neither fires on an ordinary data frame', () => {
    expect(subscribeRefusal({ success: false, ret_msg: 'boom', op: 'subscribe' }, 'orderbook.50.BTCUSDT')).toBe('boom');
    expect(subscribeRefusal({ success: false }, 'orderbook.50.BTCUSDT')).toBe('subscribe refused with no message');
    expect(subscribeRefusal({ success: true, data: { failTopics: ['orderbook.50.BTCUSDT'] } }, 'orderbook.50.BTCUSDT')).toContain(
      'failTopics',
    );
    // Somebody else's rejected topic is not ours.
    expect(subscribeRefusal({ success: true, data: { failTopics: ['orderbook.50.ETHUSDT'] } }, 'orderbook.50.BTCUSDT')).toBeNull();
    expect(subscribeRefusal({ success: true, ret_msg: 'pong', op: 'ping' }, 'orderbook.50.BTCUSDT')).toBeNull();
    expect(
      subscribeRefusal({ topic: 'orderbook.50.BTCUSDT', type: 'delta', data: { u: 1, b: [], a: [] } }, 'orderbook.50.BTCUSDT'),
    ).toBeNull();
    // A trade frame's `data` is an array, and an array has no `failTopics`.
    expect(subscribeRefusal({ topic: 'publicTrade.BTCUSDT', data: [{ i: '1' }] }, 'publicTrade.BTCUSDT')).toBeNull();
  });

  it('never guesses an aggressor', () => {
    expect(takerSideOf('Buy')).toBe('buy');
    expect(takerSideOf('Sell')).toBe('sell');
    // A guessed aggressor looks like a fact and poisons every volume-side signal.
    expect(takerSideOf('buy')).toBeNull();
    expect(takerSideOf(undefined)).toBeNull();
    expect(takerSideOf(1)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// END TO END — the EXISTING fabric machinery, driving the new venue unchanged
//
// This is the point of choosing a venue that numbers both its REST book and its
// stream: `MaintainedBook` and `SequencedBookTracker` are not modified, not
// subclassed and not parameterised for Bybit. If they were, the second venue
// would have bought a second book implementation with its own bugs.
// ════════════════════════════════════════════════════════════════════════════

describe('MaintainedBook on bybit-spot — subscribe, buffer, snapshot, join', () => {
  /** Let the pending microtasks (the seeding fetch, the delta pump) settle. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('subscribes BEFORE snapshotting, and joins across the buffered window', async () => {
    const http = new FakeHttp().queue(orderbook(100));
    const stream = new FakeStream();
    const book = new MaintainedBook(adapter(http, stream), 'BTC/USDT');

    const running = book.run();
    await settle();

    // Socket opened and subscribed first. That ordering is the whole point:
    // updates in this window would otherwise be lost with no discontinuity.
    expect(stream.opened).toHaveLength(1);
    expect(stream.sent()).toEqual([{ op: 'subscribe', args: ['orderbook.50.BTCUSDT'] }]);
    expect(book.venueId).toBe('bybit-spot');

    stream.socket().push(depthFrame('snapshot', 100));
    stream.socket().push(depthFrame('delta', 101, { b: [['30001.00', '3.00']] }));
    await settle();

    expect(book.servable).toBe(true);
    expect(book.status).toEqual({ kind: 'live', sequence: 101 });
    expect(formatAmount(book.top()!.bestBid!)).toBe('30001');
    expect(formatAmount(book.top()!.bestAsk!)).toBe('30002');

    await book.close();
    stream.socket().close();
    await running;
  });

  it('WITHHOLDS the book on a gap and rebuilds from a fresh snapshot', async () => {
    const http = new FakeHttp().queue(orderbook(100)).queue(orderbook(200));
    const stream = new FakeStream();
    const book = new MaintainedBook(adapter(http, stream), 'BTC/USDT');

    const running = book.run();
    await settle();
    stream.socket().push(depthFrame('delta', 101, { b: [['30001.00', '3.00']] }));
    await settle();
    expect(book.servable).toBe(true);

    // 102 never arrives.
    stream.socket().push(depthFrame('delta', 103, { b: [['31000.00', '9.00']] }));
    await settle();

    expect(book.tracker.lastDesync?.reason).toBe('gap');
    // Two reads: the seed and the rebuild.
    expect(http.requests).toHaveLength(2);
    // Rebuilt at 200, and the gapped 31000 bid did NOT survive.
    expect(book.servable).toBe(true);
    expect(formatAmount(book.top()!.bestBid!)).toBe('30000');

    await book.close();
    stream.socket().close();
    await running;
  });

  /**
   * THE FROZEN BOOK THIS REFUSAL EXISTS TO PREVENT.
   *
   * Bybit documents that it re-sends a full snapshot, often with `u = 1`, when it
   * restarts the feed. Its numbering is void from that moment. Skipping those
   * frames quietly would make the tracker read every renumbered delta as
   * `already-applied` — so the book freezes at its last good sequence while
   * `status` keeps saying `live` and `servable` keeps saying true. There is no
   * symptom at all.
   *
   * Failing turns that into a STOPPED feed: excluded and reported (§27).
   */
  it('STOPS the feed when the venue restarts and renumbers, rather than serving a frozen book', async () => {
    const http = new FakeHttp().queue(orderbook(100));
    const stream = new FakeStream();
    const book = new MaintainedBook(adapter(http, stream), 'BTC/USDT');

    const running = book.run();
    await settle();
    stream.socket().push(depthFrame('snapshot', 100));
    stream.socket().push(depthFrame('delta', 101, { b: [['30001.00', '3.00']] }));
    await settle();
    expect(book.servable).toBe(true);

    // The venue restarts: a second full snapshot, numbering back at 1.
    stream.socket().push(depthFrame('snapshot', 1));
    await settle();

    const status = await running;
    expect(status.kind).toBe('stopped');
    expect(status.kind === 'stopped' && status.reason).toContain('its feed restarted');
    // The book is GONE, not stale-but-served.
    expect(book.servable).toBe(false);
    expect(book.top()).toBeNull();
    expect(book.levels('bids')).toEqual([]);
  });

  it('runs a 200-frame stream through the real adapter without drifting', async () => {
    const http = new FakeHttp().queue(orderbook(0));
    const stream = new FakeStream();
    const book = new MaintainedBook(adapter(http, stream), 'BTC/USDT');

    const running = book.run();
    await settle();

    stream.socket().push(depthFrame('snapshot', 0));
    for (let i = 1; i <= 200; i += 1) {
      stream.socket().push(depthFrame('delta', i, { b: [['30001.00', `${i}.00`]] }));
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

// ════════════════════════════════════════════════════════════════════════════
// THE TRADING HALF — loud not_ready, never silent success
// ════════════════════════════════════════════════════════════════════════════

describe('BybitSpotTrade / BybitSpotAccount — signed trade and SPOT wallet observation', () => {
  const order = {
    symbol: 'BTC/USDT',
    side: 'buy' as const,
    type: 'limit' as const,
    amount: 1n,
    price: 1n,
    clientOrderId: 'abc',
  };
  const keys = { venueId: 'bybit-spot', apiKey: 'k', apiSecret: 's', scopes: ['read', 'trade'] as const };
  const openRow = {
    orderId: '9',
    orderLinkId: 'abc',
    symbol: 'BTCUSDT',
    side: 'Buy',
    orderType: 'Limit',
    price: '1',
    qty: '1',
    cumExecQty: '0',
    avgPrice: '0',
    orderStatus: 'New',
    createdTime: '1',
  };
  const envelope = (list: unknown[]) => ({ retCode: 0, retMsg: 'OK', result: { list } });

  it('placeOrder signs POST and maps the realtime row', async () => {
    const http = new FakeHttp()
      .queue(orderbook(1))
      .queue({ retCode: 0, retMsg: 'OK', result: { orderId: '9', orderLinkId: 'abc' } })
      .queue(envelope([openRow]));
    const trade = new BybitSpotTrade(keys, { http, clock: () => 1_700_000_000_000, snapshotLimit: 5 });
    const placed = await trade.placeOrder(order);
    expect(placed.status).toBe('open');
    expect(placed.filled).toBe(0n);
    expect(placed.clientOrderId).toBe('abc');
    expect(http.posts[0]!.headers?.['X-BAPI-SIGN']).toMatch(/^[a-f0-9]{64}$/);
    expect(http.requests[0]).toContain('/v5/market/orderbook');
    expect(http.requests[1]).toContain('POST https://api.bybit.com/v5/order/create');
    expect(http.posts[0]!.jsonBody).toMatchObject({ timeInForce: 'GTC' });
  });

  it('sends IOC, and a closed order that has left the realtime list is read from history', async () => {
    const filled = {
      ...openRow,
      orderStatus: 'Filled',
      cumExecQty: '1',
      avgPrice: '1',
      cumExecFee: '0.1',
      cumFeeDetail: { USDT: '0.1' },
    };
    const http = new FakeHttp()
      .queue(orderbook(1))
      .queue({ retCode: 0, retMsg: 'OK', result: { orderId: '9', orderLinkId: 'abc' } })
      .queue(envelope([]))
      .queue(envelope([filled]));
    const trade = new BybitSpotTrade(keys, { http, clock: () => 1_700_000_000_000, snapshotLimit: 5 });
    const placed = await trade.placeOrder({ ...order, timeInForce: 'IOC' });
    expect(http.posts[0]!.jsonBody).toMatchObject({ timeInForce: 'IOC' });
    expect(http.requests.some((url) => url.includes('/v5/order/history'))).toBe(true);
    expect(placed.status).toBe('filled');
    expect(formatAmount(placed.feePaid!)).toBe('0.1');
    expect(placed.feeAsset).toBe('USDT');
  });

  it('finds a closed order older than 7 days when the history window is given', async () => {
    const day = 24 * 60 * 60 * 1000;
    const placedAt = 1_700_000_000_000 - 8 * day;
    const now = placedAt + 8 * day;
    const window = { startTimeMs: placedAt - 60_000, endTimeMs: placedAt + 10 * 60 * 1000 };
    const old = {
      ...openRow,
      orderStatus: 'Filled',
      cumExecQty: '1',
      avgPrice: '1',
      cumExecFee: '0',
      createdTime: String(placedAt),
    };
    const http: HttpPort & { requests: string[] } = {
      requests: [],
      async get(url: string) {
        this.requests.push(url);
        const query = new URL(url).searchParams;
        const hit = query.get('startTime') === String(window.startTimeMs) && query.get('endTime') === String(window.endTimeMs);
        return { status: 200, body: envelope(hit ? [old] : []), header: () => null };
      },
      async post() {
        throw new Error('history lookup is a GET');
      },
    };
    const trade = new BybitSpotTrade(keys, { http, clock: () => now });
    await expect(trade.fetchClosedOrder('BTC/USDT', 'abc')).resolves.toBeNull();
    expect(http.requests[0]).toContain('/v5/order/history');
    expect(http.requests[0]).not.toContain('startTime=');
    const found = await trade.fetchClosedOrder('BTC/USDT', 'abc', window);
    expect(found?.status).toBe('filled');
    expect(found?.clientOrderId).toBe('abc');
    expect(http.requests[1]).toContain(`startTime=${window.startTimeMs}`);
    expect(http.requests[1]).toContain(`endTime=${window.endTimeMs}`);
    expect(window.endTimeMs).toBeLessThan(now - 7 * day);
  });

  it('an empty history list is a miss, and a long client id never reaches HTTP', async () => {
    const http = new FakeHttp().queue(envelope([]));
    const trade = new BybitSpotTrade(keys, { http, clock: () => 1 });
    await expect(trade.fetchClosedOrder('BTC/USDT', 'abc')).resolves.toBeNull();
    expect(http.requests[0]).toContain('/v5/order/history');
    const blocked = new FakeHttp();
    const refused = new BybitSpotTrade(keys, { http: blocked, clock: () => 1, snapshotLimit: 5 });
    await expect(refused.placeOrder({ ...order, clientOrderId: 'x'.repeat(37) })).rejects.toMatchObject({ sent: false });
    expect(blocked.requests).toHaveLength(0);
  });

  it('retCode 10001 throws and does not return a rejected order', async () => {
    const http = new FakeHttp().queue(orderbook(1)).queue({ retCode: 10001, retMsg: 'Qty invalid', result: {} });
    const trade = new BybitSpotTrade(keys, { http, clock: () => 1, snapshotLimit: 5 });
    try {
      await trade.placeOrder(order);
      expect.unreachable('placeOrder should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(VenueUnavailableError);
      expect((error as VenueUnavailableError).reason).not.toBe('not_ready');
    }
  });

  it('openOrders without symbol throws — empty list is not a stand-in', async () => {
    const trade = new BybitSpotTrade(keys, { http: new FakeHttp(), clock: () => 1 });
    await expect(trade.openOrders()).rejects.toThrow(VenueUnavailableError);
  });

  it('openOrders with symbol maps the list', async () => {
    const http = new FakeHttp().queue(envelope([openRow]));
    const trade = new BybitSpotTrade(keys, { http, clock: () => 1 });
    const open = await trade.openOrders('BTC/USDT');
    expect(open).toHaveLength(1);
    expect(open[0]!.status).toBe('open');
  });

  it('balances maps SPOT wallet-balance coins from signed GET', async () => {
    const http = new FakeHttp().queue({
      retCode: 0,
      retMsg: 'OK',
      result: {
        list: [
          {
            accountType: 'SPOT',
            coin: [
              { coin: 'USDT', walletBalance: '100', locked: '10', availableToWithdraw: '90' },
              { coin: 'BTC', walletBalance: '1', locked: '0', availableToWithdraw: '1' },
            ],
          },
        ],
      },
    });
    const account = new BybitSpotAccount(keys, { http, clock: () => 1_700_000_000_000 });
    const rows = await account.balances();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.asset).toBe('USDT');
    expect(formatAmount(rows[0]!.free)).toBe('90');
    expect(formatAmount(rows[0]!.used)).toBe('10');
    expect(formatAmount(rows[0]!.total)).toBe('100');
    expect(http.requests[0]).toContain('/v5/account/wallet-balance?accountType=UNIFIED');
    expect(http.requests[0]).not.toMatch(/^POST /);
  });

  it('spot positions is [] — honest empty, not not_ready', async () => {
    expect(await new BybitSpotAccount(keys, { http: new FakeHttp() }).positions()).toEqual([]);
  });

  it('transferRails stays not_ready — wallet permission refused', async () => {
    await expect(new BybitSpotAccount(keys).transferRails()).rejects.toMatchObject({ reason: 'not_ready' });
  });

  it('without credentials, throws missing-key rather than a fabricated order', async () => {
    await expect(new BybitSpotTrade().placeOrder(order)).rejects.toThrow(VenueCredentialsMissingError);
    await expect(new BybitSpotAccount().balances()).rejects.toThrow(VenueCredentialsMissingError);
  });

  it('public market data is unchanged — snapshotBook still needs no key', async () => {
    const http = new FakeHttp().queue(orderbook(1));
    const snapshot = await adapter(http, new FakeStream()).snapshotBook('BTC/USDT', 50);
    expect(snapshot.venueId).toBe('bybit-spot');
    expect(snapshot.sequence).toBe(1);
    expect(snapshot.bids).not.toHaveLength(0);
  });

  it('reads one taker fee rate and refuses a list that is not exactly one row', async () => {
    const row = { symbol: 'BTCUSDT', takerFeeRate: '0.001', makerFeeRate: '0.0005' };
    expect(formatAmount(bybitTakerCommissionRate({ result: { list: [row] } })!)).toBe('0.001');
    expect(bybitTakerCommissionRate({ result: { list: [row, row] } })).toBeNull();
    expect(bybitTakerCommissionRate({ result: { list: [{}] } })).toBeNull();
    const http = new FakeHttp().queue({ retCode: 0, retMsg: 'OK', result: { list: [row] } });
    const trade = new BybitSpotTrade(keys, { http, restBase: 'https://rest.test', clock: () => 1 });
    expect(formatAmount((await trade.commissionRate('BTC/USDT'))!)).toBe('0.001');
    expect(http.requests[0]).toContain('/v5/account/fee-rate');
    expect(http.requests[0]).toContain('category=spot');
    expect(http.requests[0]).toContain('symbol=BTCUSDT');
  });

  it('reads tick, step and min notional from instruments-info', async () => {
    const instrument = {
      symbol: 'BTCUSDT',
      status: 'Trading',
      lotSizeFilter: { basePrecision: '0.000001', minOrderAmt: '5' },
      priceFilter: { tickSize: '0.01' },
    };
    expect(formatAmount(bybitSymbolFilters(instrument)!.tickSize)).toBe('0.01');
    expect(formatAmount(bybitSymbolFilters(instrument)!.stepSize)).toBe('0.000001');
    expect(formatAmount(bybitSymbolFilters(instrument)!.minNotional)).toBe('5');
    expect(bybitSymbolFilters({ ...instrument, status: 'PreLaunch' })).toBeNull();
    const http = new FakeHttp().queue({ retCode: 0, retMsg: 'OK', result: { list: [instrument] } });
    const trade = new BybitSpotTrade(keys, { http, restBase: 'https://rest.test', clock: () => 1 });
    const filters = await trade.symbolFilters('BTC/USDT');
    expect(formatAmount(filters!.minNotional)).toBe('5');
    expect(http.requests[0]).toBe('https://rest.test/v5/market/instruments-info?category=spot&symbol=BTCUSDT');
  });

  it('names a definite rejection by its retCode', async () => {
    const http = new FakeHttp().queue(orderbook(1)).queue({ retCode: 170131, retMsg: 'Insufficient balance', result: {} });
    const trade = new BybitSpotTrade(keys, { http, restBase: 'https://rest.test', clock: () => 1, snapshotLimit: 5 });
    await expect(trade.placeOrder(order)).rejects.toMatchObject({
      sent: true,
      reason: 'unreachable',
      message: expect.stringMatching(/retCode 170131 \(Insufficient balance\)/),
    });
  });

  it('tags a follow-up realtime read that the governor refuses as sent', async () => {
    const http = new FakeHttp().queue(orderbook(1)).queue({ retCode: 0, retMsg: 'OK', result: { orderId: '9', orderLinkId: 'abc' } });
    const governor = new RateLimitGovernor(
      { venueId: 'bybit-spot', capacity: 1, windowMs: 60_000, reservedHeadroomBps: 0, burstBps: 10_000 },
      1,
    );
    const trade = new BybitSpotTrade(keys, { http, clock: () => 1, snapshotLimit: 5, governor });
    await expect(trade.placeOrder(order)).rejects.toMatchObject({ sent: true, reason: 'rate_limited' });
    expect(http.requests.some((url) => url.includes('/v5/order/create'))).toBe(true);
    expect(http.requests.some((url) => url.includes('/v5/order/realtime'))).toBe(false);
  });
});
