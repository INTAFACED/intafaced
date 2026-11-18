import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { DepthSnapshot } from '@intafaced/market-data';
import { DepthHub } from './depth/hub.js';
import type { DepthSource } from './depth/source.js';
import { PerIpGuard } from './per-ip.js';
import { PrivateOrderHub } from './private/hub.js';
import { registerRoutes } from './routes.js';
import { TradeHub } from './trade/hub.js';
import { createWebSocketGateway, type WebSocketGateway } from './ws/gateway.js';

/** DV-limits-03, J-developer-09 #6, over a real socket: the per-IP cap, the storm ban and GET /policy. */

const MARKET = 'BTC-USDT';
const snapshot: DepthSnapshot = { type: 'snapshot', marketId: MARKET, sequence: 1, bids: [['100', '1']], asks: [['101', '1']] };
const source: DepthSource = { markets: async () => [MARKET], snapshot: async () => snapshot };
const log = { info: vi.fn(), warn: vi.fn() };

/** Opens a socket; resolves with it once open, or with the refusal's status and JSON body. */
function attempt(url: string): Promise<{ ws: WebSocket } | { status: number; body: { code?: string } }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve({ ws }));
    ws.on('unexpected-response', (_req, res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text || '{}') }));
    });
    ws.on('error', () => undefined);
  });
}

async function opened(url: string): Promise<WebSocket> {
  const result = await attempt(url);
  if (!('ws' in result)) throw new Error(`refused ${result.status} ${JSON.stringify(result.body)}`);
  return result.ws;
}

async function closeAll(sockets: WebSocket[]): Promise<void> {
  await Promise.all(
    sockets.map(
      (ws) =>
        new Promise<void>((resolve) =>
          ws.readyState === WebSocket.CLOSED ? resolve() : (ws.once('close', () => resolve()), ws.terminate()),
        ),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('the per-IP cap on the public doors', () => {
  let app: FastifyInstance;
  let gateway: WebSocketGateway;
  let url: string;
  let base: string;
  let guard: PerIpGuard;
  let clock: { now: number };

  async function start(policy: ConstructorParameters<typeof PerIpGuard>[0]): Promise<void> {
    clock = { now: 1_000_000 };
    guard = new PerIpGuard(policy, () => clock.now);
    app = Fastify({ logger: false });
    const hub = new DepthHub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 50,
      marketsRefreshMs: 0,
    });
    const tradeHub = new TradeHub({
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 50,
      recentLimit: 10,
      ensureKnownMarket: (id) => hub.ensureKnownMarket(id),
    });
    const privateHub = new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 4, maxConnectionsPerUser: 4 });
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
      privateBus: () => false,
      perIpPolicy: () => guard.view(),
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    base = `127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    url = `ws://${base}/stream?market=${MARKET}`;
    gateway = createWebSocketGateway({
      server: app.server,
      hub,
      tradeHub,
      heartbeatMs: 60_000,
      log,
      enabled: () => true,
      admitAddress: (ip) => guard.admit(ip),
    });
    await hub.refreshMarkets();
  }

  afterEach(async () => {
    await gateway.close('test over');
    await app.close();
  });

  describe('with every value set', () => {
    beforeEach(() => start({ maxConnections: 2, stormsBeforeBan: 2, banSeconds: 20 }));

    it('publishes the policy', async () => {
      const res = await fetch(`http://${base}/policy`);
      expect(await res.json()).toMatchObject({ perIp: { maxConnections: 2, stormsBeforeBan: 2, banSeconds: 20, cap: 'set', ban: 'set' } });
    });

    it('refuses the one over the cap with its typed code, keeps the others, and frees a seat on close', async () => {
      const held = [await opened(url), await opened(url)];
      expect(await attempt(url)).toMatchObject({ status: 429, body: { code: 'ws.per_ip_cap' } });
      expect(held.every((ws) => ws.readyState === WebSocket.OPEN)).toBe(true);
      await closeAll([held[0]!]);
      const again = await opened(url);
      await closeAll([held[1]!, again]);
    });

    it('bans an address after repeated storms, for the owner-set time', async () => {
      for (let storm = 0; storm < 2; storm += 1) {
        const held = [await opened(url), await opened(url)];
        expect(await attempt(url)).toMatchObject({ status: 429, body: { code: 'ws.per_ip_cap' } });
        await closeAll(held);
      }
      expect(await attempt(url)).toMatchObject({ status: 429, body: { code: 'ws.ip_banned' } });
      clock.now += 20_000;
      await closeAll([await opened(url)]);
    });
  });

  it('a blank ban time leaves the ban off and says so; the cap still holds', async () => {
    await start({ maxConnections: 1, stormsBeforeBan: 2, banSeconds: undefined });
    const res = await fetch(`http://${base}/policy`);
    expect(await res.json()).toMatchObject({
      perIp: { maxConnections: 1, stormsBeforeBan: 2, banSeconds: null, cap: 'set', ban: 'unset' },
    });
    for (let storm = 0; storm < 4; storm += 1) {
      const held = [await opened(url)];
      expect(await attempt(url)).toMatchObject({ status: 429, body: { code: 'ws.per_ip_cap' } });
      await closeAll(held);
    }
    await closeAll([await opened(url)]);
  });

  it('a blank cap refuses every public socket by its typed code', async () => {
    await start({ maxConnections: undefined, stormsBeforeBan: undefined, banSeconds: undefined });
    expect(await attempt(url)).toMatchObject({ status: 503, body: { code: 'ws.per_ip_cap_unset' } });
  });
});
