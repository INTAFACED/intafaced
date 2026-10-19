/**
 * S33 markets — services/svc-ws.
 *
 * MKT-0097 (side means the maker side) is not asserted here. MKT-0108 requires
 * one taker side on the tape, and that is the meaning this service states.
 * A maker side is not copied into `side`.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { DepthSnapshot } from '@intafaced/market-data';
import { DepthHub } from './depth/hub.js';
import { DEPTH_ENGINE_UNAVAILABLE } from './depth/hub.js';
import { DepthNoBookError, DepthSourceError, type DepthSource } from './depth/source.js';
import { NewConnectionWindow } from './new-connection-window.js';
import { PrivateOrderHub } from './private/hub.js';
import { registerRoutes } from './routes.js';
import { PUBLIC_TAPE_SIDE_MEANING, TradeHub, type TradeSink } from './trade/hub.js';
import { WS_DEPTH_LIMIT_UNSET } from './depth-limit.js';
import { createWebSocketGateway, type WebSocketGateway } from './ws/gateway.js';
import { CandleHub } from './mux/candle-hub.js';
import { TickerHub } from './mux/ticker-hub.js';
import { MuxSession, type MuxSocket } from './mux/session.js';

const MARKET = 'BTC-USDT';

function ladder(bids: Array<[string, string]>, asks: Array<[string, string]>, sequence = 4): DepthSnapshot {
  return { type: 'snapshot', marketId: MARKET, sequence, bids, asks };
}

class RecordingSource implements DepthSource {
  readonly calls: Array<{ marketId: string; limit: number }> = [];
  failMarkets = false;

  constructor(private readonly book: DepthSnapshot | 'nobook' | 'down') {}

  async markets(): Promise<readonly string[]> {
    if (this.failMarkets) throw new Error('listing down');
    return [MARKET];
  }

  async snapshot(marketId: string, limit: number): Promise<DepthSnapshot> {
    this.calls.push({ marketId, limit });
    if (this.book === 'nobook') throw new DepthNoBookError(marketId);
    if (this.book === 'down') throw new DepthSourceError('matching down', 503);
    return this.book;
  }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function httpApp(opts: { depthLimit: number | undefined; source: RecordingSource; tradeHub?: TradeHub; hub?: DepthHub }) {
  const hub =
    opts.hub ??
    new DepthHub(opts.source, {
      depthLimit: opts.depthLimit,
      highWaterBytes: 1_000,
      maxLagTicks: 3,
      maxConnections: 100,
      marketsRefreshMs: 0,
      registry: opts.source,
    });
  if (!opts.hub) await hub.refreshMarkets().catch(() => undefined);
  const tradeHub =
    opts.tradeHub ??
    new TradeHub({
      highWaterBytes: 1_000,
      maxLagTicks: 3,
      maxConnections: 100,
      recentLimit: 10,
      ensureKnownMarket: (id) => hub.ensureKnownMarket(id),
    });
  const privateHub = new PrivateOrderHub({
    highWaterBytes: 1_000,
    maxLagTicks: 3,
    maxConnections: 100,
    maxConnectionsPerUser: 100,
  });
  const app = Fastify({ logger: false });
  registerRoutes(app, {
    hub,
    tradeHub,
    privateHub,
    source: opts.source,
    depthLimit: opts.depthLimit,
    serviceName: 'svc-ws-test',
    upstream: 'http://matching.test',
    enabled: () => true,
    tradesBus: () => false,
    privateBus: () => false,
  });
  return { app, hub, tradeHub, source: opts.source };
}

class MemorySink implements TradeSink {
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

describe('MKT-0016 empty public tape', () => {
  it('GET trades for a listed market with no prints is 404 NoTape', async () => {
    const { app } = await httpApp({ depthLimit: 50, source: new RecordingSource('nobook') });
    const res = await app.inject({ method: 'GET', url: `/markets/${MARKET}/trades` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NoTape' });
    expect(res.json()).not.toEqual([]);
    expect(res.json()).not.toMatchObject({ trades: [] });
    await app.close();
  });

  it('a listing failure is 502, and an empty array is not success', async () => {
    const source = new RecordingSource('nobook');
    source.failMarkets = true;
    const hub = new DepthHub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 3,
      maxConnections: 100,
      marketsRefreshMs: 0,
      registry: source,
    });
    const { app } = await httpApp({ depthLimit: 50, source, hub });
    const res = await app.inject({ method: 'GET', url: `/markets/${MARKET}/trades` });
    expect(res.statusCode).toBe(502);
    expect(res.json()).not.toEqual([]);
    expect(res.json()).not.toMatchObject({ trades: [] });
    await app.close();
  });

  it('keeps the tape socket open and sends no frames when a listed market has no prints', async () => {
    const source = new RecordingSource('nobook');
    const hub = new DepthHub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 3,
      maxConnections: 100,
      marketsRefreshMs: 0,
    });
    await hub.refreshMarkets();
    const tradeHub = new TradeHub({
      highWaterBytes: 1_000,
      maxLagTicks: 3,
      maxConnections: 100,
      recentLimit: 10,
      ensureKnownMarket: (id) => hub.ensureKnownMarket(id),
    });
    const sink = new MemorySink();
    expect(tradeHub.attach(MARKET, sink)).not.toBeNull();
    await settle();
    await settle();
    expect(sink.closed).toBeNull();
    expect(sink.frames).toEqual([]);
  });
});

describe('MKT-0123 desk tape poll', () => {
  it('GET trades is 404 and the body is not an empty array', async () => {
    const { app } = await httpApp({ depthLimit: 50, source: new RecordingSource('nobook') });
    const res = await app.inject({ method: 'GET', url: `/markets/${MARKET}/trades` });
    expect(res.statusCode).toBe(404);
    expect(Array.isArray(res.json())).toBe(false);
    expect(res.json()).not.toMatchObject({ trades: [] });
    await app.close();
  });
});

describe('MKT-0102 empty order book', () => {
  it('a listed market with no resting depth is NoBook and the body has no priced levels', async () => {
    const { app } = await httpApp({ depthLimit: 50, source: new RecordingSource('nobook') });
    const res = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NoBook' });
    expect(res.json()).not.toHaveProperty('bids');
    expect(res.json()).not.toHaveProperty('asks');
    await app.close();
  });

  it('matching down is 502, not an empty 200 book', async () => {
    const { app } = await httpApp({ depthLimit: 50, source: new RecordingSource('down') });
    const res = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth` });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: DEPTH_ENGINE_UNAVAILABLE });
    expect(res.json()).not.toMatchObject({ bids: [], asks: [] });
    await app.close();
  });
});

describe('MKT-0119 named absence', () => {
  it('no bids and no asks is a named absence, not a live ladder', async () => {
    const empty = ladder([], []);
    const { app } = await httpApp({ depthLimit: 50, source: new RecordingSource(empty) });
    const res = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NoBook' });
    expect(res.json()).not.toMatchObject({ type: 'snapshot' });
    await app.close();
  });
});

describe('MKT-0115 and MKT-0130 published depth window', () => {
  it('loads the book with the published window of 50 and does not send limit 200', async () => {
    const book = ladder(
      Array.from({ length: 60 }, (_, i) => [String(100 - i), '1']),
      Array.from({ length: 60 }, (_, i) => [String(200 + i), '1']),
    );
    const source = new RecordingSource(book);
    const { app } = await httpApp({ depthLimit: 50, source });
    const res = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth?limit=200` });
    expect(res.statusCode).toBe(200);
    expect(source.calls).toEqual([{ marketId: MARKET, limit: 50 }]);
    expect(res.json().bids).toHaveLength(50);
    expect(res.json().asks).toHaveLength(50);
    await app.close();
  });

  it('a blank owner limit does not fall back to 200', async () => {
    const source = new RecordingSource(ladder([['100', '1']], [['101', '1']]));
    const { app } = await httpApp({ depthLimit: undefined, source });
    const res = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth?limit=200` });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: WS_DEPTH_LIMIT_UNSET });
    expect(source.calls).toEqual([]);
    expect(res.json()).not.toHaveProperty('bids');
    await app.close();
  });
});

describe('MKT-0125 crossed house book', () => {
  it('sends no snapshot when the best bid equals the best ask, and the poll does not offer it', async () => {
    const crossed = ladder(
      [
        ['100', '2'],
        ['99', '1'],
      ],
      [
        ['100', '3'],
        ['101', '1'],
      ],
    );
    const source = new RecordingSource(crossed);
    const hub = new DepthHub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 3,
      maxConnections: 100,
      marketsRefreshMs: 0,
    });
    await hub.refreshMarkets();
    const frames: string[] = [];
    const detach = hub.attach(MARKET, {
      bufferedBytes: 0,
      send(frame: string) {
        frames.push(frame);
      },
      close() {},
    });
    expect(detach).not.toBeNull();
    await settle();
    await settle();
    expect(frames.filter((frame) => frame.includes('"snapshot"'))).toEqual([]);
    expect(hub.bookFor(MARKET)).toBeUndefined();

    const { app } = await httpApp({ depthLimit: 50, source, hub });
    const res = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).not.toHaveProperty('bids');
    expect(res.json()).not.toHaveProperty('asks');
    await app.close();
  });

  it('withholds a book whose best bid is above the best ask', async () => {
    const source = new RecordingSource(ladder([['105', '1']], [['100', '1']]));
    const { app } = await httpApp({ depthLimit: 50, source });
    const res = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NoBook' });
    expect(res.json()).not.toMatchObject({ bids: [['105', '1']] });
    await app.close();
  });
});

describe('MKT-0108 taker side', () => {
  it('REST tape and websocket tape both show taker side sell, with price, size and time', async () => {
    expect(PUBLIC_TAPE_SIDE_MEANING).toBe('taker');
    const source = new RecordingSource('nobook');
    const hub = new DepthHub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 3,
      maxConnections: 100,
      marketsRefreshMs: 0,
    });
    await hub.refreshMarkets();
    const tradeHub = new TradeHub({
      highWaterBytes: 1_000,
      maxLagTicks: 3,
      maxConnections: 100,
      recentLimit: 10,
      ensureKnownMarket: (id) => hub.ensureKnownMarket(id),
    });
    const sink = new MemorySink();
    expect(tradeHub.attach(MARKET, sink)).not.toBeNull();
    await settle();
    const fill = {
      marketId: MARKET,
      price: '64000.5',
      qty: '0.25',
      sequence: 9,
      ts: '2026-10-17T04:00:00.000Z',
      takerSide: 'sell' as const,
      // Maker-looking residual. Public `side` stays the taker side.
      side: 'buy' as const,
      makerOrderId: '11111111-1111-4111-8111-111111111111',
      takerOrderId: '22222222-2222-4222-8222-222222222222',
    };
    tradeHub.ingest(fill);
    await settle();
    expect(sink.frames).toHaveLength(1);
    const live = JSON.parse(sink.frames[0]!) as Record<string, unknown>;
    expect(live).toMatchObject({
      side: 'sell',
      price: '64000.5',
      quantity: '0.25',
      ts: '2026-10-17T04:00:00.000Z',
    });
    expect(live).not.toHaveProperty('makerOrderId');
    expect(live).not.toHaveProperty('takerOrderId');
    expect(live).not.toHaveProperty('makerSide');

    const { app } = await httpApp({ depthLimit: 50, source, hub, tradeHub });
    const res = await app.inject({ method: 'GET', url: `/markets/${MARKET}/trades` });
    expect(res.statusCode).toBe(200);
    expect(res.json().trades[0]).toMatchObject({
      side: 'sell',
      price: '64000.5',
      quantity: '0.25',
      ts: '2026-10-17T04:00:00.000Z',
    });
    expect(res.json().trades[0]).not.toHaveProperty('makerSide');
    await app.close();
  });

  it('orderFilled with no takerSide is not given an invented side', async () => {
    const source = new RecordingSource('nobook');
    const hub = new DepthHub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 3,
      maxConnections: 100,
      marketsRefreshMs: 0,
    });
    await hub.refreshMarkets();
    const tradeHub = new TradeHub({
      highWaterBytes: 1_000,
      maxLagTicks: 3,
      maxConnections: 100,
      recentLimit: 10,
      ensureKnownMarket: (id) => hub.ensureKnownMarket(id),
    });
    const sink = new MemorySink();
    expect(tradeHub.attach(MARKET, sink)).not.toBeNull();
    await settle();
    const fill = {
      marketId: MARKET,
      price: '64000.5',
      qty: '0.25',
      sequence: 9,
      ts: '2026-10-17T04:00:00.000Z',
      side: 'buy' as const,
      makerOrderId: '11111111-1111-4111-8111-111111111111',
      takerOrderId: '22222222-2222-4222-8222-222222222222',
    };
    tradeHub.ingest(fill);
    await settle();
    const live = JSON.parse(sink.frames[0]!) as Record<string, unknown>;
    expect(live).not.toHaveProperty('side');
    expect(live).not.toHaveProperty('makerSide');

    const { app } = await httpApp({ depthLimit: 50, source, hub, tradeHub });
    const res = await app.inject({ method: 'GET', url: `/markets/${MARKET}/trades` });
    expect(res.statusCode).toBe(200);
    expect(res.json().trades[0]).not.toHaveProperty('side');
    expect(res.json().trades[0]).not.toHaveProperty('makerSide');
    await app.close();
  });
});

describe('MKT-0096 subscription cap and connection burst', () => {
  it('refuses the subscribe past 1000 and leaves the earlier subscriptions open', async () => {
    const source = new RecordingSource(ladder([['100', '1']], [['101', '1']]));
    const depth = new DepthHub(source, {
      depthLimit: 50,
      highWaterBytes: 1000,
      maxLagTicks: 3,
      maxConnections: 1100,
      muxMaxConnections: 1100,
      marketsRefreshMs: 0,
    });
    const trades = new TradeHub({
      highWaterBytes: 1000,
      maxLagTicks: 3,
      maxConnections: 1100,
      muxMaxConnections: 1100,
      recentLimit: 10,
      ensureKnownMarket: (id) => depth.ensureKnownMarket(id),
    });
    const tickers = new TickerHub({ highWaterBytes: 1000, maxLagTicks: 3, maxConnections: 1100, throttleMs: 1000 });
    const candles = new CandleHub({ highWaterBytes: 1000, maxLagTicks: 3, maxConnections: 1100 });
    const frames: Array<Record<string, unknown>> = [];
    const socket: MuxSocket = {
      bufferedBytes: 0,
      send(frame: string) {
        frames.push(JSON.parse(frame) as Record<string, unknown>);
      },
      close(_code: number, _reason: string) {},
    };
    const clock = { now: 1_000_000 };
    const session = new MuxSession(socket, {
      depth,
      trades,
      tickers,
      candles,
      resolver: {
        async resolve(input: string) {
          return /^T\d+$/.test(input) ? { id: input, symbol: null } : null;
        },
      },
      maxSubscriptions: 1000,
      maxOpsPerSecond: 1000,
      highWaterBytes: 1000,
      log: { info() {}, warn() {} },
      clock: () => clock.now,
    });
    expect(session.start()).toBe(true);

    const channels = Array.from({ length: 1000 }, (_, i) => ({ ch: 'ticker', market: `T${i}` }));
    for (let offset = 0; offset < channels.length; offset += 64) {
      const acksBefore = frames.filter((frame) => frame.op === 'ack').length;
      session.onMessage(JSON.stringify({ op: 'subscribe', channels: channels.slice(offset, offset + 64) }));
      for (let spin = 0; spin < 30 && frames.filter((frame) => frame.op === 'ack').length === acksBefore; spin += 1) {
        await settle();
      }
    }
    expect(session.subscriptions).toBe(1000);

    clock.now += 1000;
    const acksBefore = frames.filter((frame) => frame.op === 'ack').length;
    session.onMessage(JSON.stringify({ op: 'subscribe', channels: [{ ch: 'ticker', market: 'T1000' }] }));
    for (let spin = 0; spin < 30 && frames.filter((frame) => frame.op === 'ack').length === acksBefore; spin += 1) {
      await settle();
    }
    const ack = frames.filter((frame) => frame.op === 'ack').at(-1) as { results: Array<{ ok: boolean; code?: string }> };
    expect(ack.results[0]).toMatchObject({ ok: false, code: 'subscription_limit' });
    expect(session.subscriptions).toBe(1000);
    expect(session.closed).toBe(false);

    clock.now += 1000;
    const beforeDrop = frames.filter((frame) => frame.op === 'ack').length;
    session.onMessage(JSON.stringify({ op: 'unsubscribe', channels: [{ ch: 'ticker', market: 'T0' }] }));
    for (let spin = 0; spin < 30 && frames.filter((frame) => frame.op === 'ack').length === beforeDrop; spin += 1) {
      await settle();
    }
    const dropped = frames.filter((frame) => frame.op === 'ack').at(-1) as { results: Array<{ ok: boolean }> };
    expect(dropped.results[0]?.ok).toBe(true);
    expect(session.subscriptions).toBe(999);
  });

  it('refuses the 31st new public connection in a minute and leaves the first open', async () => {
    const source = new RecordingSource(ladder([['100', '1']], [['101', '1']]));
    const hub = new DepthHub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 3,
      maxConnections: 100,
      marketsRefreshMs: 0,
    });
    await hub.refreshMarkets();
    const tradeHub = new TradeHub({
      highWaterBytes: 1_000,
      maxLagTicks: 3,
      maxConnections: 100,
      recentLimit: 10,
      ensureKnownMarket: (id) => hub.ensureKnownMarket(id),
    });
    const app = Fastify({ logger: false });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const window = new NewConnectionWindow(30, () => 1_700_000_000_000);
    let gateway: WebSocketGateway | undefined;
    const open: WebSocket[] = [];
    try {
      gateway = createWebSocketGateway({
        server: app.server,
        hub,
        tradeHub,
        heartbeatMs: 60_000,
        log: { info() {}, warn() {} },
        enabled: () => true,
        admitNewConnection: () => window.admit(),
      });
      const url = `ws://127.0.0.1:${port}/stream?market=${MARKET}`;
      const first = await openPublicSocket(url);
      expect(first.status).toBe('open');
      open.push(first.ws);
      for (let n = 0; n < 29; n += 1) {
        const next = await openPublicSocket(url);
        expect(next.status).toBe('open');
        open.push(next.ws);
      }
      const refused = await openPublicSocket(url);
      expect(refused.status).toBe(429);
      expect(first.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      for (const ws of open) ws.close();
      await gateway?.close('test over');
      await app.close();
    }
  });

  it('a blank new-connection cap does not invent 30', () => {
    const window = new NewConnectionWindow(undefined, () => 0);
    for (let n = 0; n < 31; n += 1) expect(window.admit()).toBe(true);
  });
});

function openPublicSocket(url: string): Promise<{ ws: WebSocket; status: 'open' | number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`socket to ${url} did not finish`));
    }, 3000);
    let settled = false;
    const finish = (status: 'open' | number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ws, status });
    };
    ws.on('open', () => finish('open'));
    ws.on('unexpected-response', (_req, res) => finish(res.statusCode ?? 0));
    ws.on('error', () => undefined);
  });
}
