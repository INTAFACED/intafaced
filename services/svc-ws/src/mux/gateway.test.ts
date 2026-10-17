import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { applyDelta, bookFromSnapshot, type DepthBook, type DepthMessage, type DepthSnapshot } from '@intafaced/market-data';
import { DepthHub } from '../depth/hub.js';
import type { DepthSource } from '../depth/source.js';
import { PrivateOrderHub } from '../private/hub.js';
import { registerRoutes } from '../routes.js';
import { TradeHub } from '../trade/hub.js';
import { createWebSocketGateway, type WebSocketGateway } from '../ws/gateway.js';
import { CandleHub } from './candle-hub.js';
import { createMuxGateway, type MuxGateway } from './gateway.js';
import { MUX_MAX_PAYLOAD_BYTES } from './protocol.js';
import { HubMarketResolver } from './resolver.js';
import type { MarketDirectory } from './sources.js';
import { TickerHub } from './ticker-hub.js';

/**
 * THE MULTIPLEXED DOOR, OVER A REAL SOCKET — beside the original one.
 *
 * The session tests prove the protocol against a fake socket. These prove the
 * glue: that `GET /stream` with no `market` is the multiplexed door, that every
 * `?market=` request is still exactly the socket it was (including ignoring
 * what the client says), and that the byte-level bounds hold on a real wire.
 */

const BTC = 'BTC-USDT';

function snapshot(sequence: number, bids: Array<[string, string]> = [['100', '1']]): DepthSnapshot {
  return { type: 'snapshot', marketId: BTC, sequence, bids, asks: [['101', '1']] };
}

class StubSource implements DepthSource {
  async markets(): Promise<readonly string[]> {
    return [BTC];
  }
  async snapshot(marketId: string): Promise<DepthSnapshot> {
    return { ...snapshot(10), marketId };
  }
}

const directory: MarketDirectory = {
  refresh: async () => undefined,
  idForSymbol: (s) => (s === 'BTC/USDT' ? BTC : null),
  symbolFor: (id) => (id === BTC ? 'BTC/USDT' : null),
};

class Client {
  readonly socket: WebSocket;
  readonly frames: any[] = [];
  closed: { code: number; reason: string } | null = null;
  readonly #waiters: Array<{ test: () => boolean; resolve: () => void }> = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on('message', (data) => {
      this.frames.push(JSON.parse(data.toString()));
      this.#settle();
    });
    this.socket.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.#settle();
    });
    this.socket.on('error', () => undefined);
  }

  #settle(): void {
    for (const waiter of [...this.#waiters]) {
      if (waiter.test() || this.closed) {
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  }

  async until(test: () => boolean): Promise<void> {
    if (test() || this.closed) return;
    await new Promise<void>((resolve) => this.#waiters.push({ test, resolve }));
  }

  async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve) => this.socket.once('open', () => resolve()));
  }

  send(value: unknown): void {
    this.socket.send(typeof value === 'string' ? value : JSON.stringify(value));
  }

  data(ch: string, market?: string): any[] {
    return this.frames.filter((f) => f.ch === ch && (market === undefined || f.market === market)).map((f) => f.data);
  }

  dispose(): void {
    this.socket.terminate();
  }
}

async function upgradeStatus(url: string): Promise<number> {
  const socket = new WebSocket(url);
  return new Promise<number>((resolve) => {
    socket.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      socket.terminate();
    });
    socket.on('error', () => resolve(0));
    socket.on('open', () => {
      socket.terminate();
      resolve(101);
    });
  });
}

const log = { info: vi.fn(), warn: vi.fn() };

describe('the multiplexed door, over a real socket', () => {
  let app: FastifyInstance;
  let hub: DepthHub;
  let tradeHub: TradeHub;
  let tickerHub: TickerHub;
  let candleHub: CandleHub;
  let mux: MuxGateway;
  let gateway: WebSocketGateway;
  let base: string;
  const clients: Client[] = [];

  async function boot(opts: { withMux: boolean; muxMax?: number | undefined; maxSubs?: number | undefined; maxOps?: number | undefined }) {
    app = Fastify({ logger: false });
    hub = new DepthHub(new StubSource(), {
      depthLimit: 50,
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 8,
      marketsRefreshMs: 0,
    });
    tradeHub = new TradeHub({
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 8,
      recentLimit: 10,
      ensureKnownMarket: (id) => hub.ensureKnownMarket(id),
    });
    tickerHub = new TickerHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 8, throttleMs: 1000 });
    candleHub = new CandleHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 8 });
    mux = createMuxGateway({
      session: {
        depth: hub,
        trades: tradeHub,
        tickers: tickerHub,
        candles: candleHub,
        resolver: new HubMarketResolver(hub, directory),
        maxSubscriptions: 'maxSubs' in opts ? opts.maxSubs : 6,
        maxOpsPerSecond: 'maxOps' in opts ? opts.maxOps : 50,
        highWaterBytes: 1_000_000,
        log,
      },
      maxConnections: 'muxMax' in opts ? opts.muxMax : 2,
      heartbeatMs: 60_000,
      log,
    });
    registerRoutes(app, {
      hub,
      tradeHub,
      privateHub: new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 4, maxConnectionsPerUser: 4 }),
      source: new StubSource(),
      depthLimit: 50,
      serviceName: 'svc-ws-test',
      upstream: 'http://matching.test',
      enabled: () => true,
      tradesBus: () => true,
      privateBus: () => false,
      mux: { gateway: mux, tickerHub, candleHub },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    base = `127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    gateway = createWebSocketGateway({
      server: app.server,
      hub,
      tradeHub,
      heartbeatMs: 60_000,
      log,
      enabled: () => true,
      ...(opts.withMux ? { mux } : {}),
    });
    await hub.refreshMarkets();
  }

  afterEach(async () => {
    for (const client of clients.splice(0)) client.dispose();
    await gateway.close('test over');
    await app.close();
  });

  function connect(path: string): Client {
    const client = new Client(`ws://${base}${path}`);
    clients.push(client);
    return client;
  }

  describe('with the door mounted', () => {
    beforeEach(() => boot({ withMux: true }));

    it('upgrades GET /stream with no market, and a client multiplexes book + trades + ticker + candles on it', async () => {
      const client = connect('/stream');
      await client.open();
      client.send({
        op: 'subscribe',
        id: 'a',
        channels: [
          { ch: 'book', market: BTC },
          { ch: 'trades', market: BTC },
          { ch: 'ticker' },
          { ch: 'candles', market: 'BTC/USDT', interval: '5m' },
        ],
      });
      await client.until(() => client.frames.some((f) => f.op === 'ack') && client.data('book', BTC).length >= 1);

      const ack = client.frames.find((f) => f.op === 'ack');
      expect(ack.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true, true, true]);
      expect(ack.results[3]).toMatchObject({ market: BTC, symbol: 'BTC/USDT', interval: '5m' });
      expect(hub.connections).toBe(1);
      expect(tradeHub.connections).toBe(1);
      expect(tickerHub.connections).toBe(1);
      expect(candleHub.connections).toBe(1);
      expect(mux.connections).toBe(1);
      expect(mux.subscriptions).toBe(4);

      hub.ingest(snapshot(11, [['100', '2']]));
      hub.ingest(
        snapshot(12, [
          ['100', '2'],
          ['99', '4'],
        ]),
      );
      await client.until(() => client.data('book', BTC).length >= 3);
      let book: DepthBook | null = null;
      for (const message of client.data('book', BTC) as DepthMessage[]) {
        if (message.type === 'snapshot') book = bookFromSnapshot(message);
        else if (message.type === 'delta' && book) {
          const result = applyDelta(book, message);
          if (!result.ok) throw new Error(result.reason);
          book = result.book;
        }
      }
      expect(book).toEqual(hub.bookFor(BTC));

      client.socket.close();
      await vi.waitFor(() => expect(hub.connections + tradeHub.connections + tickerHub.connections + candleHub.connections).toBe(0));
      expect(mux.connections).toBe(0);
    });

    it('BACKWARD COMPATIBLE: ?market= is still the original socket — snapshot then deltas, bare frames, inbound ignored', async () => {
      const legacy = connect(`/stream?market=${BTC}`);
      await legacy.until(() => legacy.frames.length >= 1);
      // A bare DepthMessage, not an envelope: nothing about today's clients changed.
      expect(legacy.frames[0]).toMatchObject({ type: 'snapshot', marketId: BTC, sequence: 10 });
      expect(legacy.frames[0]).not.toHaveProperty('ch');

      // A mux-shaped message to a legacy socket is not interpreted.
      legacy.send({ op: 'subscribe', channels: [{ ch: 'ticker' }] });
      hub.ingest(snapshot(11, [['100', '2']]));
      await legacy.until(() => legacy.frames.length >= 2);
      expect(legacy.frames[1]).toMatchObject({ type: 'delta', fromSequence: 10, sequence: 11 });
      expect(legacy.frames.some((f) => f.op === 'ack' || f.op === 'error')).toBe(false);
      expect(tickerHub.connections).toBe(0);
      expect(legacy.closed).toBeNull();

      const trades = connect(`/stream?market=${BTC}&channel=trades`);
      await trades.open();
      tradeHub.ingest({
        marketId: BTC,
        makerOrderId: 'm',
        takerOrderId: 't',
        price: '100',
        qty: '1',
        sequence: 1,
        ts: '2026-07-29T12:00:01.000Z',
      } as never);
      await trades.until(() => trades.frames.length >= 1);
      expect(trades.frames[0]).toMatchObject({ type: 'trade', marketId: BTC });
      expect(trades.frames[0]).not.toHaveProperty('ch');
    });

    it('legacy refusals are unchanged: empty market, oversized market, unknown path', async () => {
      expect(await upgradeStatus(`ws://${base}/stream?market=`)).toBe(400);
      expect(await upgradeStatus(`ws://${base}/stream?market=${'x'.repeat(65)}`)).toBe(400);
      expect(await upgradeStatus(`ws://${base}/nope`)).toBe(404);
    });

    it('refuses L3 / SBE asks on the multiplexed door with the same typed 409', async () => {
      expect(await upgradeStatus(`ws://${base}/stream?format=sbe`)).toBe(409);
      expect(await upgradeStatus(`ws://${base}/stream?channel=l3`)).toBe(409);
    });

    it('closes 1009 on a frame over the payload bound, before it is assembled', async () => {
      const client = connect('/stream');
      await client.open();
      client.send('x'.repeat(MUX_MAX_PAYLOAD_BYTES + 1));
      await client.until(() => client.closed !== null);
      expect(client.closed?.code).toBe(1009);
    });

    it('answers a binary frame with a typed error and keeps the connection', async () => {
      const client = connect('/stream');
      await client.open();
      client.socket.send(Buffer.from([1, 2, 3]));
      await client.until(() => client.frames.length >= 1);
      expect(client.frames[0]).toMatchObject({ op: 'error', code: 'bad_request' });
      expect(client.closed).toBeNull();
    });

    it('closes 1008 when the client floods operations', async () => {
      const client = connect('/stream');
      await client.open();
      for (let i = 0; i < 80; i += 1) client.send('{}');
      await client.until(() => client.closed !== null);
      expect(client.closed?.code).toBe(1008);
      expect(client.closed?.reason).toContain('rate_limited');
    });

    it('closes the newest connection 1013 at the owner-published connection ceiling, and frees the seat on close', async () => {
      const a = connect('/stream');
      const b = connect('/stream');
      await a.open();
      await b.open();
      const c = connect('/stream');
      await c.until(() => c.closed !== null);
      expect(c.closed?.code).toBe(1013);
      expect(mux.connections).toBe(2);
      a.socket.close();
      await vi.waitFor(() => expect(mux.connections).toBe(1));
      const d = connect('/stream');
      await d.open();
      d.send({ op: 'subscribe', channels: [{ ch: 'ticker' }] });
      await d.until(() => d.frames.length >= 1);
      expect(d.frames[0]).toMatchObject({ op: 'ack' });
    });

    it('shows up on /health beside the other doors', async () => {
      const a = connect('/stream');
      await a.open();
      a.send({ op: 'subscribe', channels: [{ ch: 'ticker' }] });
      await a.until(() => a.frames.length >= 1);
      const health = await app.inject({ method: 'GET', url: '/health' });
      expect(health.json().capacity.mux).toMatchObject({ connections: 1, maxConnections: 2, subscriptions: 1 });
    });

    it('a gateway close tells every multiplexed client why (1001) instead of dropping the TCP connection', async () => {
      const a = connect('/stream');
      await a.open();
      a.send({ op: 'subscribe', channels: [{ ch: 'book', market: BTC }] });
      await a.until(() => a.frames.length >= 2);
      await gateway.close('maintenance');
      await a.until(() => a.closed !== null);
      expect(a.closed?.code).toBe(1001);
    });
  });

  describe('unpublished ceilings', () => {
    it('closes 1008 with the *_unset name when the connection ceiling is blank', async () => {
      await boot({ withMux: true, muxMax: undefined });
      const c = connect('/stream');
      await c.until(() => c.closed !== null);
      expect(c.closed).toMatchObject({ code: 1008 });
      expect(c.closed?.reason).toContain('max_connections_unset');
    });

    it('closes 1008 when the subscription ceiling is blank', async () => {
      await boot({ withMux: true, maxSubs: undefined });
      const c = connect('/stream');
      await c.until(() => c.closed !== null);
      expect(c.closed?.code).toBe(1008);
      expect(c.closed?.reason).toContain('mux_max_subscriptions_unset');
    });
  });

  describe('without the door mounted', () => {
    beforeEach(() => boot({ withMux: false }));

    it('GET /stream with no market is the 400 it has always been', async () => {
      expect(await upgradeStatus(`ws://${base}/stream`)).toBe(400);
    });
  });
});
