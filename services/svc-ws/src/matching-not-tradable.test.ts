import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { DepthSnapshot } from '@intafaced/market-data';
import { DEPTH_ENGINE_UNAVAILABLE, DepthHub, snapshotHasRestingDepth, type DepthSink } from './depth/hub.js';
import { HttpDepthSource, type DepthSource } from './depth/source.js';
import { DepthPoller } from './depth/poller.js';
import {
  DEPTH_MARKET_DELISTED,
  DEPTH_MARKET_EXPIRED,
  DEPTH_MARKET_HALTED,
  DEPTH_MARKET_PRELAUNCH,
  DEPTH_VENUE_HALTED,
  ORDERS_MARKET_HALTED,
  ORDERS_SUBMITS_RESUMED,
  ORDERS_VENUE_HALTED,
  type DepthMatchingTradingCode,
} from './matching-trading.js';
import { PrivateOrderHub } from './private/hub.js';
import { registerRoutes } from './routes.js';
import { TradeHub, type TradeSink } from './trade/hub.js';

const MARKET = 'BTC-USDT';
const OTHER = 'ETH-USDT';

function liveSnapshot(sequence: number, marketId = MARKET): DepthSnapshot {
  return { type: 'snapshot', marketId, sequence, bids: [['100', '1']], asks: [['101', '1']] };
}

class FakeSink implements DepthSink, TradeSink {
  readonly frames: string[] = [];
  closed: { code: number; reason: string } | null = null;
  bufferedBytes = 0;
  send(frame: string): void {
    this.frames.push(frame);
  }
  close(code: number, reason: string): void {
    this.closed ??= { code, reason };
  }
}

class FakeSource implements DepthSource {
  constructor(
    readonly marketList: string[],
    readonly current = new Map<string, DepthSnapshot>(),
    readonly tradingByMarket = new Map<string, DepthMatchingTradingCode>(),
    public venueHalt = false,
  ) {}

  async markets(): Promise<readonly string[]> {
    return this.marketList;
  }

  async snapshot(marketId: string): Promise<DepthSnapshot> {
    const s = this.current.get(marketId);
    if (!s) throw new Error(`no upstream book for ${marketId}`);
    return s;
  }

  trading(marketId: string): DepthMatchingTradingCode | null {
    return this.tradingByMarket.get(marketId) ?? (this.venueHalt ? DEPTH_VENUE_HALTED : null);
  }

  venueHalted(): boolean {
    return this.venueHalt;
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function depthHub(source: FakeSource) {
  return new DepthHub(source, {
    depthLimit: 50,
    highWaterBytes: 1_000,
    maxLagTicks: 3,
    maxConnections: 100,
    marketsRefreshMs: 0,
  });
}

function expectNoTradableBook(frames: readonly string[]): void {
  for (const frame of frames) {
    const msg = JSON.parse(frame) as { type?: string };
    expect(msg.type, `tradable depth on the wire: ${frame}`).not.toBe('snapshot');
    expect(msg.type, `tradable delta on the wire: ${frame}`).not.toBe('delta');
    if (msg.type === 'snapshot') expect(snapshotHasRestingDepth(msg as never)).toBe(false);
  }
}

describe('matching not-tradable — public depth', () => {
  for (const [label, code] of [
    ['halted', DEPTH_MARKET_HALTED],
    ['prelaunch', DEPTH_MARKET_PRELAUNCH],
    ['expired', DEPTH_MARKET_EXPIRED],
    ['delisted', DEPTH_MARKET_DELISTED],
  ] as const) {
    it(`names ${label} and withholds the ladder — no invented prices`, async () => {
      const source = new FakeSource([MARKET], new Map([[MARKET, liveSnapshot(3)]]), new Map([[MARKET, code]]));
      const hub = depthHub(source);
      const sink = new FakeSink();
      hub.attach(MARKET, sink);
      await settle();

      expect(sink.closed).toBeNull();
      expect(hub.matchingTrading(MARKET)).toBe(code);
      expect(sink.frames.map((f) => JSON.parse(f))).toEqual([{ type: 'status', code, marketId: MARKET }]);
      expectNoTradableBook(sink.frames);
    });
  }

  it('names venue halt-all and does not emit a tradable book', async () => {
    const source = new FakeSource([MARKET], new Map([[MARKET, liveSnapshot(4)]]), new Map(), true);
    const hub = depthHub(source);
    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    await settle();

    expect(sink.frames.map((f) => JSON.parse(f))).toEqual([{ type: 'status', code: DEPTH_VENUE_HALTED, marketId: MARKET }]);
    expectNoTradableBook(sink.frames);
  });

  it('does not fan out later polls as tradable while halted', async () => {
    const source = new FakeSource([MARKET], new Map([[MARKET, liveSnapshot(1)]]), new Map([[MARKET, DEPTH_MARKET_HALTED]]));
    const hub = depthHub(source);
    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    await settle();
    hub.noteMatchingTrading(MARKET, DEPTH_MARKET_HALTED);
    hub.ingest(liveSnapshot(9));

    expectNoTradableBook(sink.frames);
    expect(hub.bookFor(MARKET)?.sequence).toBe(9);
  });

  it("resumes with a snapshot of matching's book — does not invent prices", async () => {
    const source = new FakeSource([MARKET], new Map([[MARKET, liveSnapshot(2)]]), new Map([[MARKET, DEPTH_MARKET_HALTED]]));
    const hub = depthHub(source);
    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    await settle();
    hub.ingest(liveSnapshot(8));

    source.tradingByMarket.delete(MARKET);
    hub.noteMatchingTrading(MARKET, null);

    const types = sink.frames.map((f) => (JSON.parse(f) as { type: string }).type);
    expect(types).toContain('status');
    expect(types.at(-1)).toBe('snapshot');
    const last = JSON.parse(sink.frames.at(-1)!) as {
      type: string;
      sequence: number;
      marketId: string;
      bids: [string, string][];
      asks: [string, string][];
    };
    expect(last).toMatchObject({ type: 'snapshot', sequence: 8, marketId: MARKET });
    expect(last.bids).toEqual([['100', '1']]);
    expect(last.asks).toEqual([['101', '1']]);
  });

  it('leaves a second market tradable when only one is halted', async () => {
    const source = new FakeSource(
      [MARKET, OTHER],
      new Map([
        [MARKET, liveSnapshot(1, MARKET)],
        [OTHER, liveSnapshot(1, OTHER)],
      ]),
      new Map([[MARKET, DEPTH_MARKET_HALTED]]),
    );
    const hub = depthHub(source);
    const halted = new FakeSink();
    const open = new FakeSink();
    hub.attach(MARKET, halted);
    hub.attach(OTHER, open);
    await settle();

    expect(JSON.parse(halted.frames[0]!)).toMatchObject({ code: DEPTH_MARKET_HALTED });
    expectNoTradableBook(halted.frames);
    expect(JSON.parse(open.frames[0]!)).toMatchObject({ type: 'snapshot', marketId: OTHER });
  });
});

describe('matching not-tradable — private stream', () => {
  it('names orders.market_halted — not a tradable blotter', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 1_000, maxLagTicks: 3, maxConnections: 10, maxConnectionsPerUser: 10 });
    const sink = new FakeSink();
    hub.attach('user-a', sink);
    hub.noteMatchingTrading(MARKET, DEPTH_MARKET_HALTED);

    expect(sink.frames.map((f) => JSON.parse(f))).toEqual([
      { type: 'status', code: ORDERS_MARKET_HALTED, channel: 'orders', userId: 'user-a', marketId: MARKET },
    ]);
  });

  it('names orders.venue_halted once per edge for a private-only seat', async () => {
    const privateHub = new PrivateOrderHub({ highWaterBytes: 1_000, maxLagTicks: 3, maxConnections: 10, maxConnectionsPerUser: 10 });
    const sink = new FakeSink();
    privateHub.attach('user-a', sink);

    const source = new FakeSource([MARKET], new Map([[MARKET, liveSnapshot(1)]]), new Map(), true);
    const depth = depthHub(source);
    const poller = new DepthPoller(
      source,
      depth,
      {
        intervalMs: 1_000,
        depthLimit: 50,
        marketsRefreshMs: 30_000,
        probePrivate: {
          connections: () => privateHub.connections,
          markDown: () => privateHub.markEngineUnavailable(),
          markUp: () => privateHub.noteEngineUp(),
          markTrading: (marketId, code) => privateHub.noteMatchingTrading(marketId, code),
        },
      },
      { info: () => undefined, warn: () => undefined },
    );

    await poller.tick();

    expect(sink.frames.map((f) => JSON.parse(f))).toEqual([
      { type: 'status', code: ORDERS_VENUE_HALTED, channel: 'orders', userId: 'user-a' },
    ]);
  });

  it('tells seats that already received a market halt that submits resumed', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 1_000, maxLagTicks: 3, maxConnections: 10, maxConnectionsPerUser: 10 });
    const orders = new FakeSink();
    const fills = new FakeSink();
    const positions = new FakeSink();
    hub.attach('user-a', orders, 'orders');
    hub.attach('user-a', fills, 'fills');
    hub.attach('user-a', positions, 'positions');
    hub.noteMatchingTrading(MARKET, DEPTH_MARKET_HALTED);
    hub.noteMatchingTrading(MARKET, null);

    const resumed = { type: 'status', code: ORDERS_SUBMITS_RESUMED, userId: 'user-a', marketId: MARKET };
    expect(orders.frames.map((f) => JSON.parse(f))).toEqual([
      { type: 'status', code: ORDERS_MARKET_HALTED, channel: 'orders', userId: 'user-a', marketId: MARKET },
      { ...resumed, channel: 'orders' },
    ]);
    expect(fills.frames.map((f) => JSON.parse(f))).toEqual([
      { type: 'status', code: ORDERS_MARKET_HALTED, channel: 'fills', userId: 'user-a', marketId: MARKET },
      { ...resumed, channel: 'fills' },
    ]);
    expect(positions.frames).toEqual([]);
    hub.noteMatchingTrading(MARKET, null);
    expect(orders.frames).toHaveLength(2);
  });

  it('tells seats that already received a venue halt that submits resumed, without a market id or a price', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 1_000, maxLagTicks: 3, maxConnections: 10, maxConnectionsPerUser: 10 });
    const sink = new FakeSink();
    hub.attach('user-a', sink);
    hub.noteMatchingTrading('*', DEPTH_VENUE_HALTED);
    hub.noteMatchingTrading('*', null);

    expect(sink.frames.map((f) => JSON.parse(f))).toEqual([
      { type: 'status', code: ORDERS_VENUE_HALTED, channel: 'orders', userId: 'user-a' },
      { type: 'status', code: ORDERS_SUBMITS_RESUMED, channel: 'orders', userId: 'user-a' },
    ]);
    const resumed = JSON.parse(sink.frames[1]!) as Record<string, unknown>;
    expect(resumed).not.toHaveProperty('marketId');
    expect(resumed).not.toHaveProperty('price');
  });

  it('does not invent submits resumed when matching never published a halt', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 1_000, maxLagTicks: 3, maxConnections: 10, maxConnectionsPerUser: 10 });
    const sink = new FakeSink();
    hub.attach('user-a', sink);
    hub.noteMatchingTrading(MARKET, null);
    hub.noteMatchingTrading('*', null);
    expect(sink.frames).toEqual([]);
  });

  it('does not tell a seat that attaches after the halt was already cleared', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 1_000, maxLagTicks: 3, maxConnections: 10, maxConnectionsPerUser: 10 });
    const early = new FakeSink();
    hub.attach('user-a', early);
    hub.noteMatchingTrading(MARKET, DEPTH_MARKET_HALTED);
    hub.noteMatchingTrading(MARKET, null);
    const late = new FakeSink();
    hub.attach('user-b', late);
    expect(late.frames).toEqual([]);
  });

  it('queues the halt and the resume until the snapshot is released', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 1_000, maxLagTicks: 3, maxConnections: 10, maxConnectionsPerUser: 10 });
    const sink = new FakeSink();
    hub.attach('user-a', sink, 'orders', { holdUntilSnapshot: true });
    hub.noteMatchingTrading(MARKET, DEPTH_MARKET_HALTED);
    hub.noteMatchingTrading(MARKET, null);
    expect(sink.frames).toEqual([]);
    hub.releaseSnapshot(sink);
    expect(sink.frames.map((f) => JSON.parse(f))).toEqual([
      { type: 'status', code: ORDERS_MARKET_HALTED, channel: 'orders', userId: 'user-a', marketId: MARKET },
      { type: 'status', code: ORDERS_SUBMITS_RESUMED, channel: 'orders', userId: 'user-a', marketId: MARKET },
    ]);
  });

  it('a cleared venue halt does not retract a market halt that is still up', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 1_000, maxLagTicks: 3, maxConnections: 10, maxConnectionsPerUser: 10 });
    const sink = new FakeSink();
    hub.attach('user-a', sink);
    hub.noteMatchingTrading('*', DEPTH_VENUE_HALTED);
    hub.noteMatchingTrading(MARKET, DEPTH_MARKET_HALTED);
    hub.noteMatchingTrading('*', null);

    expect(sink.frames.map((f) => JSON.parse(f))).toEqual([
      { type: 'status', code: ORDERS_VENUE_HALTED, channel: 'orders', userId: 'user-a' },
      { type: 'status', code: ORDERS_MARKET_HALTED, channel: 'orders', userId: 'user-a', marketId: MARKET },
      { type: 'status', code: ORDERS_SUBMITS_RESUMED, channel: 'orders', userId: 'user-a' },
    ]);
    const late = new FakeSink();
    hub.attach('user-b', late);
    expect(late.frames.map((f) => JSON.parse(f))).toEqual([
      { type: 'status', code: ORDERS_MARKET_HALTED, channel: 'orders', userId: 'user-b', marketId: MARKET },
    ]);
  });

  it('does not call a cleared prelaunch submits resumed', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 1_000, maxLagTicks: 3, maxConnections: 10, maxConnectionsPerUser: 10 });
    const sink = new FakeSink();
    hub.attach('user-a', sink);
    hub.noteMatchingTrading(MARKET, DEPTH_MARKET_PRELAUNCH);
    hub.noteMatchingTrading(MARKET, null);
    expect(sink.frames.map((f) => JSON.parse(f))).toEqual([
      { type: 'status', code: 'orders.market_prelaunch', channel: 'orders', userId: 'user-a', marketId: MARKET },
    ]);
  });
});

describe('matching not-tradable — HTTP depth', () => {
  it('GET /markets/:id/depth is 409 named halt, not a 200 ladder', async () => {
    const source = new FakeSource([MARKET], new Map([[MARKET, liveSnapshot(5)]]), new Map([[MARKET, DEPTH_MARKET_HALTED]]));
    const hub = depthHub(source);
    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    await settle();

    const tradeHub = new TradeHub({
      highWaterBytes: 1_000,
      maxLagTicks: 3,
      maxConnections: 100,
      recentLimit: 10,
      ensureKnownMarket: (id) => hub.ensureKnownMarket(id),
    });
    const app = Fastify({ logger: false });
    registerRoutes(app, {
      hub,
      tradeHub,
      privateHub: new PrivateOrderHub({ highWaterBytes: 1_000, maxLagTicks: 3, maxConnections: 100, maxConnectionsPerUser: 100 }),
      source,
      depthLimit: 50,
      serviceName: 'svc-ws-test',
      upstream: 'http://matching.test',
      enabled: () => true,
      tradesBus: () => false,
      privateBus: () => false,
    });

    const res = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ type: 'status', code: DEPTH_MARKET_HALTED, marketId: MARKET });
    expect(res.json()).not.toMatchObject({ type: 'snapshot' });
    await app.close();
  });
});

describe('HttpDepthSource matching flags', () => {
  it('reads halt flags off matching depth and does not invent a price', async () => {
    const source = new HttpDepthSource({
      baseUrl: 'http://matching.test/',
      fetch: (async () =>
        new Response(
          JSON.stringify({
            marketId: MARKET,
            sequence: 3,
            bids: [['100', '1']],
            asks: [['101', '1']],
            halted: true,
            prelaunch: false,
            expired: false,
            delisted: false,
            venueHalted: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof globalThis.fetch,
    });

    const snap = await source.snapshot(MARKET, 50);
    expect(snap.bids[0]?.[0]).toBe('100');
    expect(source.trading(MARKET)).toBe(DEPTH_MARKET_HALTED);
  });

  it('reads the GET /markets board for private-only venue halt', async () => {
    const source = new HttpDepthSource({
      baseUrl: 'http://matching.test/',
      fetch: (async () =>
        new Response(
          JSON.stringify({
            markets: [MARKET],
            venueHalted: true,
            halted: [],
            prelaunch: [],
            expired: [],
            delisted: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof globalThis.fetch,
    });

    await expect(source.markets()).resolves.toEqual([MARKET]);
    expect(source.venueHalted()).toBe(true);
    expect(source.trading(MARKET)).toBe(DEPTH_VENUE_HALTED);
  });

  it('does not treat engine-down as a matching halt name', () => {
    expect(DEPTH_ENGINE_UNAVAILABLE).not.toBe(DEPTH_MARKET_HALTED);
  });
});
