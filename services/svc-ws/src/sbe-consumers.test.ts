/**
 * J-cex-spot-20 #3: the SBE tape's consumers from the adapter's own record, one row per open `format=sbe` socket with
 * the last tape sequence sent, read only by svc-edge with the dedicated read key.
 */
import type { IncomingMessage } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { createSbeCodec, type JavaSbeCodec } from '@intafaced/sbe-codec';
import type { DepthSnapshot } from '@intafaced/market-data';
import { DepthHub } from './depth/hub.js';
import type { DepthSource } from './depth/source.js';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { SBE_STATUS_PATH, SbeConsumers, registerSbeStatusDoor } from './sbe-consumers.js';
import { TradeHub } from './trade/hub.js';
import { createWebSocketGateway, type WebSocketGateway } from './ws/gateway.js';

const MARKET = 'BTC-USDT';

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

const READ_KEY = 'r'.repeat(32);

describe('SBE consumer status', () => {
  let app: FastifyInstance;
  let hub: DepthHub;
  let gateway: WebSocketGateway;
  let consumers: SbeConsumers;
  let base: string;
  const clients: Client[] = [];
  const sbe = createSbeCodec({ java: stubJava() });

  beforeEach(async () => {
    const source = new StubSource();
    app = Fastify({ logger: false });
    hub = new DepthHub(source, { depthLimit: 50, highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 8, marketsRefreshMs: 0 });
    const tradeHub = new TradeHub({
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 8,
      recentLimit: 10,
      ensureKnownMarket: (id) => hub.ensureKnownMarket(id),
    });
    consumers = new SbeConsumers();
    registerSbeStatusDoor(app, { consumers, secret: READ_KEY, codecLinked: () => sbe.linked });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    base = `127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    gateway = createWebSocketGateway({
      server: app.server,
      hub,
      tradeHub,
      heartbeatMs: 60_000,
      log: { info: vi.fn(), warn: vi.fn() },
      enabled: () => true,
      sbe,
      sbeConsumers: consumers,
    });
    await hub.refreshMarkets();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.dispose();
    await gateway.close('test over');
    await app.close();
  });

  const read = (service = 'svc-edge', key = READ_KEY) =>
    app.inject({ method: 'GET', url: SBE_STATUS_PATH, headers: serviceAuthHeadersForBody(service, key, '') });

  it('lists each open SBE socket with the last tape sequence it was sent, and drops it on close', async () => {
    const empty = await read();
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ service: 'svc-ws', codecLinked: true, consumers: [] });

    const client = new Client(`ws://${base}/stream?market=${MARKET}&format=sbe`);
    clients.push(client);
    await client.frameCount(1);
    // A JSON depth socket is not an SBE consumer.
    const json = new Client(`ws://${base}/stream?market=${MARKET}`);
    clients.push(json);
    await json.frameCount(1);

    const one = (await read()).json() as { consumers: Array<Record<string, unknown>> };
    expect(one.consumers).toHaveLength(1);
    expect(one.consumers[0]).toMatchObject({ id: 'sbe-1', marketId: MARKET, lastSequence: '10' });
    expect(one.consumers[0]!.framesSent).toBeGreaterThanOrEqual(1);
    // Market data only: nothing about an account, a balance or Greeks.
    expect(JSON.stringify(one)).not.toMatch(/balance|margin|greeks|delta|account|user/i);

    client.socket.close();
    await expect.poll(async () => ((await read()).json() as { consumers: unknown[] }).consumers.length).toBe(0);
  });

  it('answers a signed svc-edge only; a blank key refuses by name', async () => {
    expect((await app.inject({ method: 'GET', url: SBE_STATUS_PATH })).statusCode).toBe(401);
    expect((await read('svc-edge', 'w'.repeat(32))).statusCode).toBe(401);
    expect((await read('svc-trade')).statusCode).toBe(403);

    const bare = Fastify({ logger: false });
    registerSbeStatusDoor(bare, { consumers: new SbeConsumers(), secret: undefined, codecLinked: () => false });
    const blank = await bare.inject({ method: 'GET', url: SBE_STATUS_PATH, headers: serviceAuthHeadersForBody('svc-edge', READ_KEY, '') });
    expect(blank.statusCode).toBe(503);
    expect(blank.json()).toMatchObject({ error: { code: 'ws_status_unconfigured' } });
    await bare.close();
  });
});
