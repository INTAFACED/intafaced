import { TEST_AUTHORITY } from './test-support/authority.js';
/**
 * M05/M06 honesty: L3/queue must not be faked. Public L2 SBE publishes via
 * sbe-codec (C4). JSON L2 is never served as SBE. Queue-probability from L2
 * alone refuses. Private binary stays unavailable.
 */
import type { IncomingMessage } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { createSbeCodec, type JavaSbeCodec } from '@intafaced/sbe-codec';
import type { DepthSnapshot } from '@intafaced/market-data';
import { DepthHub } from './depth/hub.js';
import type { DepthSource } from './depth/source.js';
import {
  DEPTH_BINARY_UNAVAILABLE,
  DEPTH_ENTITLEMENT_UNAUTHORIZED,
  DEPTH_L3_UNAVAILABLE,
  DEPTH_SBE_UNAVAILABLE,
  MARKET_DATA_FEED_REFUSE_HTTP,
} from './gateway-policy.js';
import { createPrivateWebSocketGateway } from './private/gateway.js';
import { PrivateOrderHub } from './private/hub.js';
import { registerRoutes } from './routes.js';
import { TradeHub } from './trade/hub.js';
import { createWebSocketGateway, type WebSocketGateway } from './ws/gateway.js';

const MARKET = 'BTC-USDT';
const SECRET = 'test-access-secret-at-least-32-chars!!';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const tokens: TokenConfig = {
  secret: SECRET,
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

function stubJava(): JavaSbeCodec {
  return {
    handle(json: string): string {
      const req = JSON.parse(json) as Record<string, unknown>;
      if (req.op === 'encode') {
        const marker = [
          String(req.template),
          String(req.instrument),
          String(req.side),
          String(req.price),
          String(req.qty),
          String(req.sequence),
        ].join(':');
        return JSON.stringify({
          ok: true,
          template: req.template,
          payloadB64: Buffer.from(marker, 'utf8').toString('base64'),
        });
      }
      return JSON.stringify({ ok: false, error: { code: 'invalid_message', message: 'decode not used' } });
    },
  };
}

class StubSource implements DepthSource {
  marketList: string[] = [MARKET];
  readonly snapshotCalls: string[] = [];
  current: DepthSnapshot = {
    type: 'snapshot',
    marketId: MARKET,
    sequence: 10,
    bids: [['100', '1']],
    asks: [['101', '1']],
  };

  async markets(): Promise<readonly string[]> {
    return this.marketList;
  }

  async snapshot(marketId: string): Promise<DepthSnapshot> {
    this.snapshotCalls.push(marketId);
    return { ...this.current, marketId };
  }
}

class Client {
  readonly socket: WebSocket;
  readonly frames: string[] = [];
  readonly binary: Buffer[] = [];
  closed: { code: number; reason: string } | null = null;
  readonly #waiters: Array<{ count: number; resolve: () => void }> = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      this.binary.push(buf);
      this.frames.push(buf.toString());
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

describe('L3 / binary subscribe honesty', () => {
  let app: FastifyInstance;
  let hub: DepthHub;
  let tradeHub: TradeHub;
  let privateHub: PrivateOrderHub;
  let source: StubSource;
  let gateway: WebSocketGateway;
  let privateGateway: ReturnType<typeof createPrivateWebSocketGateway>;
  let base: string;
  const clients: Client[] = [];
  const sbe = createSbeCodec({ java: stubJava() });

  beforeEach(async () => {
    source = new StubSource();
    app = Fastify({ logger: false });
    hub = new DepthHub(source, {
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
    privateHub = new PrivateOrderHub({
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 8,
      maxConnectionsPerUser: 8,
    });
    registerRoutes(app, {
      hub,
      tradeHub,
      privateHub,
      source,
      depthLimit: 50,
      serviceName: 'svc-ws-test',
      upstream: 'http://matching.test',
      enabled: () => true,
      tradesBus: () => true,
      privateBus: () => true,
      sbe,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    base = `127.0.0.1:${port}`;
    const log = { info: vi.fn(), warn: vi.fn() };
    gateway = createWebSocketGateway({
      server: app.server,
      hub,
      tradeHub,
      heartbeatMs: 60_000,
      log,
      enabled: () => true,
      sbe,
    });
    privateGateway = createPrivateWebSocketGateway({
      authority: TEST_AUTHORITY,
      server: app.server,
      hub: privateHub,
      heartbeatMs: 60_000,
      log,
      enabled: () => true,
      tokens,
    });
    await hub.refreshMarkets();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.dispose();
    await gateway.close('test over');
    await privateGateway.close('test over');
    await app.close();
  });

  function connect(query: string): Client {
    const client = new Client(`ws://${base}/stream?${query}`);
    clients.push(client);
    return client;
  }

  it('refuses L3 / order-by-order / queue-position with depth.l3_unavailable and does not attach L2', async () => {
    for (const query of [
      `market=${MARKET}&channel=l3`,
      `market=${MARKET}&channel=order-by-order`,
      `market=${MARKET}&channel=queue-position`,
      `market=${MARKET}&channel=queue-probability`,
      `market=${MARKET}&level=3`,
    ]) {
      const refused = await upgradeRefuse(`ws://${base}/stream?${query}`);
      expect(refused.status).toBe(MARKET_DATA_FEED_REFUSE_HTTP);
      expect(refused.body).toMatchObject({ type: 'status', code: DEPTH_L3_UNAVAILABLE });
    }
    expect(hub.connections).toBe(0);
    expect(source.snapshotCalls).toEqual([]);
  });

  it('publishes public L2 SBE frames — not JSON bids, never L3', async () => {
    const client = connect(`market=${MARKET}&format=sbe`);
    await client.frameCount(1);
    expect(client.closed).toBeNull();
    expect(client.binary.length).toBeGreaterThan(0);
    const wire = client.binary.map((b) => b.toString('utf8')).join('\n');
    expect(wire).not.toMatch(/"bids"/);
    expect(wire).not.toMatch(/L3/i);
    expect(() => JSON.parse(client.frames[0]!)).toThrow();
  });

  it('refuses L4 / maker identity on the L2 SBE tape', async () => {
    const l4 = await upgradeRefuse(`ws://${base}/stream?market=${MARKET}&format=sbe&level=4`);
    expect(l4.status).toBe(MARKET_DATA_FEED_REFUSE_HTTP);
    expect(l4.body).toMatchObject({ type: 'status', code: DEPTH_ENTITLEMENT_UNAUTHORIZED });
    const maker = await upgradeRefuse(`ws://${base}/stream?market=${MARKET}&format=sbe&maker=1`);
    expect(maker.status).toBe(MARKET_DATA_FEED_REFUSE_HTTP);
    expect(maker.body).toMatchObject({ type: 'status', code: DEPTH_ENTITLEMENT_UNAUTHORIZED });
    expect(hub.connections).toBe(0);
  });

  it('still serves L2 JSON depth and public trades', async () => {
    const depth = connect(`market=${MARKET}`);
    await depth.frameCount(1);
    expect(depth.parsed()[0]).toMatchObject({ type: 'snapshot', marketId: MARKET, sequence: 10 });
    expect(depth.closed).toBeNull();

    const tape = connect(`market=${MARKET}&channel=trades`);
    await new Promise((r) => setTimeout(r, 40));
    tradeHub.ingest({
      marketId: MARKET,
      price: '30100.5',
      qty: '0.1',
      sequence: 50,
      ts: '2026-07-29T12:00:00.000Z',
    } as never);
    await tape.frameCount(1);
    expect(tape.parsed()[0]).toMatchObject({ type: 'trade', marketId: MARKET, sequence: 50 });
    expect(tape.closed).toBeNull();
  });

  it('GET depth/trades names L3 refuse and publishes L2 SBE without a JSON book', async () => {
    const l3 = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth?channel=l3` });
    expect(l3.statusCode).toBe(MARKET_DATA_FEED_REFUSE_HTTP);
    expect(l3.json()).toMatchObject({ type: 'status', code: DEPTH_L3_UNAVAILABLE });
    expect(l3.json()).not.toHaveProperty('bids');

    const sbeGet = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth?format=sbe` });
    expect(sbeGet.statusCode).toBe(200);
    expect(sbeGet.headers['x-intafaced-book']).toBe('L2');
    expect(sbeGet.headers['x-intafaced-template']).toBe('DepthLevel');
    expect(sbeGet.headers['content-type']).toMatch(/octet-stream/);
    expect(sbeGet.rawPayload.byteLength).toBeGreaterThan(0);
    expect(sbeGet.body).not.toContain('"bids"');
    expect(sbeGet.body).not.toMatch(/L3/i);

    const l3sbe = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth?channel=l3&format=sbe` });
    expect(l3sbe.statusCode).toBe(MARKET_DATA_FEED_REFUSE_HTTP);
    expect(l3sbe.json()).toMatchObject({ type: 'status', code: DEPTH_BINARY_UNAVAILABLE });
    expect(l3sbe.json()).not.toHaveProperty('bids');

    const entitled = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth?format=sbe&level=4` });
    expect(entitled.statusCode).toBe(MARKET_DATA_FEED_REFUSE_HTTP);
    expect(entitled.json()).toMatchObject({ type: 'status', code: DEPTH_ENTITLEMENT_UNAUTHORIZED });
    expect(entitled.json()).not.toHaveProperty('bids');

    const tape = await app.inject({ method: 'GET', url: `/markets/${MARKET}/trades?encoding=binary` });
    expect(tape.statusCode).toBe(MARKET_DATA_FEED_REFUSE_HTTP);
    expect(tape.json()).toMatchObject({ type: 'status', code: DEPTH_BINARY_UNAVAILABLE });

    const l2 = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth` });
    expect(l2.statusCode).toBe(200);
    expect(l2.json()).toMatchObject({ type: 'snapshot', marketId: MARKET });
    expect(l2.json().bids).toEqual([['100', '1']]);
  });

  it('unknown public channel stays 400 — not an L3 code', async () => {
    const refused = await upgradeRefuse(`ws://${base}/stream?market=${MARKET}&channel=orders`);
    expect(refused.status).toBe(400);
    expect(refused.body).not.toMatchObject({ code: DEPTH_L3_UNAVAILABLE });
  });

  it('private stream refuses L3/queue and binary; orders channel still opens', async () => {
    const l3 = await upgradeRefuse(`ws://${base}/private/stream?channel=queue-position`);
    expect(l3.status).toBe(MARKET_DATA_FEED_REFUSE_HTTP);
    expect(l3.body).toMatchObject({ type: 'status', code: DEPTH_L3_UNAVAILABLE });

    const privateSbe = await upgradeRefuse(`ws://${base}/private/stream?channel=orders&format=sbe`);
    expect(privateSbe.status).toBe(MARKET_DATA_FEED_REFUSE_HTTP);
    expect(privateSbe.body).toMatchObject({ type: 'status', code: DEPTH_BINARY_UNAVAILABLE });

    const { token } = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:read'] }, tokens);
    const seat = new Client(`ws://${base}/private/stream?channel=orders&access_token=${token}`);
    clients.push(seat);
    await seat.frameCount(1);
    expect(seat.parsed().some((f) => f.channel === 'orders' && f.type === 'ready')).toBe(true);
    expect(seat.closed).toBeNull();
    expect(privateHub.connections).toBe(1);
  });
});

describe('L2 SBE unlinked codec', () => {
  it('GET format=sbe names depth.sbe_unavailable and does not serve JSON bids', async () => {
    const source = new StubSource();
    const app = Fastify({ logger: false });
    const hub = new DepthHub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 8,
      marketsRefreshMs: 0,
    });
    const tradeHub = new TradeHub({
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
      tradeHub,
      privateHub,
      source,
      depthLimit: 50,
      serviceName: 'svc-ws-test',
      upstream: 'http://matching.test',
      enabled: () => true,
      tradesBus: () => true,
      privateBus: () => true,
      sbe: createSbeCodec({ java: null }),
    });
    await app.ready();
    await hub.refreshMarkets();

    const sbeGet = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth?format=sbe` });
    expect(sbeGet.statusCode).toBe(MARKET_DATA_FEED_REFUSE_HTTP);
    expect(sbeGet.json()).toMatchObject({ type: 'status', code: DEPTH_SBE_UNAVAILABLE });
    expect(sbeGet.json()).not.toHaveProperty('bids');

    await app.close();
  });
});
