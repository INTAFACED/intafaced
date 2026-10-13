/**
 * H2 WS: project matching native L3. Never copy L2 size tuples.
 */
import type { IncomingMessage } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import type { DepthSnapshot } from '@intafaced/market-data';
import { resolveWsCopy, WS_COPY } from './copy.js';
import { CLOSE_TRY_LATER, DepthHub } from './depth/hub.js';
import { NativeL3Hub } from './depth/l3-hub.js';
import { DepthL3UnavailableError, type DepthSource, type NativeL3Queue } from './depth/source.js';
import { DEPTH_BINARY_UNAVAILABLE, DEPTH_L3_UNAVAILABLE, MARKET_DATA_FEED_REFUSE_HTTP } from './gateway-policy.js';
import { PrivateOrderHub } from './private/hub.js';
import { registerRoutes } from './routes.js';
import { TradeHub } from './trade/hub.js';
import { createWebSocketGateway, type WebSocketGateway } from './ws/gateway.js';

const MARKET = 'BTC-USDT';

const native: NativeL3Queue = {
  level: 'L3',
  marketId: MARKET,
  bids: [{ price: '99.5', orders: [{ orderId: 'b1', remaining: '0.5', sequence: 1 }] }],
  asks: [{ price: '100.5', orders: [{ orderId: 'a1', remaining: '1.25', sequence: 2 }] }],
};

class Source implements DepthSource {
  marketList: string[] = [MARKET];
  snapshotCalls: string[] = [];
  l3Calls: string[] = [];
  queue: NativeL3Queue | DepthL3UnavailableError = native;
  l2: DepthSnapshot = {
    type: 'snapshot',
    marketId: MARKET,
    sequence: 10,
    bids: [['99.5', '0.5']],
    asks: [['100.5', '1.25']],
  };

  async markets(): Promise<readonly string[]> {
    return this.marketList;
  }

  async snapshot(marketId: string): Promise<DepthSnapshot> {
    this.snapshotCalls.push(marketId);
    return { ...this.l2, marketId };
  }

  async l3Queue(marketId: string): Promise<NativeL3Queue> {
    this.l3Calls.push(marketId);
    if (this.queue instanceof DepthL3UnavailableError) throw this.queue;
    return { ...this.queue, marketId };
  }
}

class Client {
  readonly socket: WebSocket;
  readonly frames: string[] = [];
  closed: { code: number; reason: string } | null = null;
  readonly #waiters: Array<{ count: number; resolve: () => void }> = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on('message', (data) => {
      this.frames.push(data.toString());
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
      if (this.frames.length >= waiter.count || this.closed) {
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  }

  async frameCount(count: number): Promise<void> {
    if (this.frames.length >= count || this.closed) return;
    await new Promise<void>((resolve) => this.#waiters.push({ count, resolve }));
  }

  parsed(): Array<Record<string, unknown>> {
    return this.frames.map((f) => JSON.parse(f) as Record<string, unknown>);
  }

  dispose(): void {
    this.socket.terminate();
  }
}

/** Holds the first native L3 read so a test can close around the in-flight probe. */
function holdFirstL3Read(source: Source): { entered: Promise<void>; release: () => void } {
  let releaseHeld!: (queue: NativeL3Queue) => void;
  const held = new Promise<NativeL3Queue>((resolve) => {
    releaseHeld = resolve;
  });
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const readQueue = source.l3Queue.bind(source);
  let first = true;
  source.l3Queue = async (marketId: string) => {
    if (!first) return readQueue(marketId);
    first = false;
    source.l3Calls.push(marketId);
    markEntered();
    const queue = await held;
    return { ...queue, marketId };
  };
  return { entered, release: () => releaseHeld(native) };
}

/** Holds every native L3 read so concurrent probes stay in flight together. */
function holdEveryL3Read(source: Source): { entered: Promise<void>; release: () => void } {
  const pending: Array<(queue: NativeL3Queue) => void> = [];
  let markEntered!: () => void;
  let enteredOnce = false;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  source.l3Queue = async (marketId: string) => {
    source.l3Calls.push(marketId);
    if (!enteredOnce) {
      enteredOnce = true;
      markEntered();
    }
    const queue = await new Promise<NativeL3Queue>((resolve) => {
      pending.push(resolve);
    });
    return { ...queue, marketId };
  };
  return {
    entered,
    release: () => {
      const waiting = pending.splice(0);
      for (const resolve of waiting) resolve(native);
    },
  };
}

/** Records whether the upgrade became a socket, then settles on open, refuse, or error. */
function trackUpgrade(url: string): { socket: WebSocket; opened: () => boolean; done: Promise<void> } {
  const socket = new WebSocket(url);
  let opened = false;
  const done = new Promise<void>((resolve) => {
    const finish = () => resolve();
    socket.on('open', () => {
      opened = true;
      finish();
    });
    socket.on('unexpected-response', (_req, res: IncomingMessage) => {
      res.resume();
      socket.terminate();
      finish();
    });
    socket.on('error', finish);
    socket.on('close', finish);
  });
  return { socket, opened: () => opened, done };
}

async function upgradeRefuse(url: string): Promise<{ status: number; body: unknown }> {
  const socket = new WebSocket(url);
  return new Promise((resolve) => {
    socket.on('unexpected-response', (_req, res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        socket.terminate();
        let body: unknown = null;
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            body = raw;
          }
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    socket.on('open', () => {
      socket.terminate();
      resolve({ status: 101, body: null });
    });
    socket.on('error', () => resolve({ status: 0, body: null }));
  });
}

describe('H2 native L3 projection', () => {
  let app: FastifyInstance;
  let hub: DepthHub;
  let l3Hub: NativeL3Hub;
  let tradeHub: TradeHub;
  let source: Source;
  let gateway: WebSocketGateway;
  let base: string;
  const clients: Client[] = [];

  beforeEach(async () => {
    source = new Source();
    app = Fastify({ logger: false });
    hub = new DepthHub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 8,
      marketsRefreshMs: 0,
    });
    l3Hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 8,
      ensureKnownMarket: (id) => hub.ensureKnownMarket(id),
    });
    tradeHub = new TradeHub({
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 8,
      recentLimit: 10,
      ensureKnownMarket: (id) => hub.ensureKnownMarket(id),
    });
    const privateHub = new PrivateOrderHub({
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 8,
      maxConnectionsPerUser: 8,
    });
    registerRoutes(app, {
      hub,
      l3Hub,
      tradeHub,
      privateHub,
      source,
      depthLimit: 50,
      serviceName: 'svc-ws-test',
      upstream: 'http://matching.test',
      enabled: () => true,
      tradesBus: () => true,
      privateBus: () => true,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    base = `127.0.0.1:${port}`;
    gateway = createWebSocketGateway({
      server: app.server,
      hub,
      tradeHub,
      l3Hub,
      heartbeatMs: 60_000,
      log: { info: vi.fn(), warn: vi.fn() },
      enabled: () => true,
    });
    await hub.refreshMarkets();
  });

  async function retarget(maxConnections: number | undefined, l3ProbeBoundMs?: number): Promise<void> {
    await gateway.close('retarget');
    l3Hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections,
      ensureKnownMarket: (id) => hub.ensureKnownMarket(id),
    });
    gateway = createWebSocketGateway({
      server: app.server,
      hub,
      tradeHub,
      l3Hub,
      heartbeatMs: 60_000,
      log: { info: vi.fn(), warn: vi.fn() },
      enabled: () => true,
      ...(l3ProbeBoundMs === undefined ? {} : { l3ProbeBoundMs }),
    });
  }

  afterEach(async () => {
    for (const client of clients.splice(0)) client.dispose();
    await gateway.close('test over');
    await app.close();
  });

  it('WS channel=l3 projects matching queue, not L2 size tuples', async () => {
    const client = new Client(`ws://${base}/stream?market=${MARKET}&channel=l3`);
    clients.push(client);
    await client.frameCount(1);
    expect(client.closed).toBeNull();
    expect(client.parsed()[0]).toMatchObject({ type: 'snapshot', transport: 'poll', level: 'L3', marketId: MARKET });
    expect(client.parsed()[0]!.asks).toEqual(native.asks);
    expect(client.parsed()[0]!.asks).not.toEqual(source.l2.asks);
    expect(source.l3Calls).toContain(MARKET);
    expect(source.snapshotCalls).toEqual([]);
    expect(hub.connections).toBe(0);
    expect(l3Hub.connections).toBe(1);
  });

  it('a native L3 probe that resolves before close still attaches', async () => {
    const gate = holdFirstL3Read(source);
    const attach = vi.spyOn(l3Hub, 'attach');
    const client = new Client(`ws://${base}/stream?market=${MARKET}&channel=l3`);
    clients.push(client);
    await gate.entered;
    gate.release();
    await client.frameCount(1);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(client.closed).toBeNull();
    expect(l3Hub.connections).toBe(1);
    expect(gateway.connections).toBe(1);
  });

  it('a native L3 probe that resolves after close does not attach', async () => {
    const gate = holdFirstL3Read(source);
    const attach = vi.spyOn(l3Hub, 'attach');
    const handleUpgrade = vi.spyOn(WebSocketServer.prototype, 'handleUpgrade');
    const upgrade = trackUpgrade(`ws://${base}/stream?market=${MARKET}&channel=l3`);
    try {
      await gate.entered;
      const upgradesWhileProbeHeld = handleUpgrade.mock.calls.length;
      await gateway.close('shutting down');
      gate.release();
      await upgrade.done;
      expect(handleUpgrade).toHaveBeenCalledTimes(upgradesWhileProbeHeld);
      expect(attach).not.toHaveBeenCalled();
      expect(upgrade.opened()).toBe(false);
      expect(l3Hub.connections).toBe(0);
      expect(gateway.connections).toBe(0);
    } finally {
      upgrade.socket.terminate();
      handleUpgrade.mockRestore();
    }
  });

  it('a native L3 handshake past maxConnections does not await probe', async () => {
    await retarget(1);
    const gate = holdFirstL3Read(source);
    const probe = vi.spyOn(l3Hub, 'probe');
    const attach = vi.spyOn(l3Hub, 'attach');
    const holder = new Client(`ws://${base}/stream?market=${MARKET}&channel=l3`);
    clients.push(holder);
    try {
      await gate.entered;
      expect(probe).toHaveBeenCalledTimes(1);
      const blocked = new Client(`ws://${base}/stream?market=${MARKET}&channel=l3`);
      clients.push(blocked);
      await Promise.race([
        blocked.frameCount(1),
        new Promise((_, reject) => setTimeout(() => reject(new Error('past-ceiling handshake stayed pinned on probe')), 500)),
      ]);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(attach).not.toHaveBeenCalled();
      expect(l3Hub.connections).toBe(0);
      expect(blocked.frames).toEqual([]);
      expect(blocked.closed).toEqual({ code: CLOSE_TRY_LATER, reason: resolveWsCopy(WS_COPY.atCapacity) });

      gate.release();
      await holder.frameCount(1);
      expect(holder.closed).toBeNull();
      expect(attach).toHaveBeenCalledTimes(1);
      expect(l3Hub.connections).toBe(1);

      const afterAttach = new Client(`ws://${base}/stream?market=${MARKET}&channel=l3`);
      clients.push(afterAttach);
      await Promise.race([
        afterAttach.frameCount(1),
        new Promise((_, reject) => setTimeout(() => reject(new Error('attached seat did not refuse the next handshake')), 500)),
      ]);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(attach).toHaveBeenCalledTimes(1);
      expect(l3Hub.connections).toBe(1);
      expect(afterAttach.frames).toEqual([]);
      expect(afterAttach.closed).toEqual({ code: CLOSE_TRY_LATER, reason: resolveWsCopy(WS_COPY.atCapacity) });
    } finally {
      gate.release();
    }
  });

  it('an unpublished maxConnections still refuses at attach', async () => {
    await retarget(undefined);
    const gate = holdEveryL3Read(source);
    const probe = vi.spyOn(l3Hub, 'probe');
    const attach = vi.spyOn(l3Hub, 'attach');
    const first = new Client(`ws://${base}/stream?market=${MARKET}&channel=l3`);
    const second = new Client(`ws://${base}/stream?market=${MARKET}&channel=l3`);
    clients.push(first, second);
    try {
      await gate.entered;
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
      expect(attach).not.toHaveBeenCalled();
      gate.release();
      await first.frameCount(1);
      await second.frameCount(1);
      expect(attach).toHaveBeenCalledTimes(2);
      expect(first.frames).toEqual([]);
      expect(second.frames).toEqual([]);
      expect(first.closed).not.toBeNull();
      expect(second.closed).not.toBeNull();
      expect(l3Hub.connections).toBe(0);
    } finally {
      gate.release();
    }
  });

  it('a native L3 probe that does not settle releases the raw socket', async () => {
    const probeBoundMs = 50;
    await retarget(1, probeBoundMs);
    const gate = holdFirstL3Read(source);
    const attach = vi.spyOn(l3Hub, 'attach');
    const hung = trackUpgrade(`ws://${base}/stream?market=${MARKET}&channel=l3`);
    try {
      await gate.entered;
      const released = await Promise.race([
        hung.done.then(() => 'released' as const),
        new Promise<'pinned'>((resolve) => setTimeout(() => resolve('pinned'), 1_000)),
      ]);
      expect(released).toBe('released');
      expect(hung.opened()).toBe(false);
      expect(attach).not.toHaveBeenCalled();
      expect(l3Hub.connections).toBe(0);
      expect(gateway.connections).toBe(0);

      const next = new Client(`ws://${base}/stream?market=${MARKET}&channel=l3`);
      clients.push(next);
      await next.frameCount(1);
      expect(next.closed).toBeNull();
      expect(attach).toHaveBeenCalledTimes(1);
      expect(l3Hub.connections).toBe(1);

      gate.release();
      await new Promise((resolve) => setTimeout(resolve, probeBoundMs));
      expect(attach).toHaveBeenCalledTimes(1);
      expect(l3Hub.connections).toBe(1);
      expect(gateway.connections).toBe(1);
    } finally {
      hung.socket.terminate();
      gate.release();
    }
  });

  it('GET /depth/l3 is native queue; GET /depth stays L2 tuples', async () => {
    const l3 = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth/l3` });
    expect(l3.statusCode).toBe(200);
    expect(l3.json()).toMatchObject({ level: 'L3', transport: 'poll', asks: native.asks });
    expect(l3.json().asks).not.toEqual([['100.5', '1.25']]);

    const viaQuery = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth?channel=l3` });
    expect(viaQuery.statusCode).toBe(200);
    expect(viaQuery.json().level).toBe('L3');
    expect(viaQuery.json().transport).toBe('poll');
    expect(viaQuery.json().asks[0].orders[0].remaining).toBe('1.25');

    const l2 = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth` });
    expect(l2.statusCode).toBe(200);
    expect(l2.json().asks).toEqual([['100.5', '1.25']]);
    expect(l2.json().level).toBeUndefined();
    expect(source.snapshotCalls.length).toBeGreaterThan(0);
  });

  it('matching l3_unavailable refuses and does not attach L2', async () => {
    source.queue = new DepthL3UnavailableError(MARKET);
    const refused = await upgradeRefuse(`ws://${base}/stream?market=${MARKET}&channel=l3`);
    expect(refused.status).toBe(MARKET_DATA_FEED_REFUSE_HTTP);
    expect(refused.body).toMatchObject({ type: 'status', code: DEPTH_L3_UNAVAILABLE });
    expect(hub.connections).toBe(0);
    expect(l3Hub.connections).toBe(0);
    expect(source.snapshotCalls).toEqual([]);

    const http = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth/l3` });
    expect(http.statusCode).toBe(MARKET_DATA_FEED_REFUSE_HTTP);
    expect(http.json()).toMatchObject({ type: 'status', code: DEPTH_L3_UNAVAILABLE });
    expect(http.json()).not.toHaveProperty('bids');
  });

  it('queue-probability stays refused; L3+SBE is binary not L2 SBE', async () => {
    const prob = await upgradeRefuse(`ws://${base}/stream?market=${MARKET}&channel=queue-probability`);
    expect(prob.status).toBe(MARKET_DATA_FEED_REFUSE_HTTP);
    expect(prob.body).toMatchObject({ type: 'status', code: DEPTH_L3_UNAVAILABLE });

    const sbe = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth?channel=l3&format=sbe` });
    expect(sbe.statusCode).toBe(MARKET_DATA_FEED_REFUSE_HTTP);
    expect(sbe.json()).toMatchObject({ type: 'status', code: DEPTH_BINARY_UNAVAILABLE });
    expect(sbe.json()).not.toHaveProperty('bids');
  });
});
