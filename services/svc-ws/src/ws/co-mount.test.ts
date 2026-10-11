import { TEST_AUTHORITY } from '../test-support/authority.js';
/**
 * Public + private gateways co-mounted on one HTTP server — production boot shape.
 * Proves public demux does not 404 /private/stream before private auth runs.
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import type { DepthSnapshot, WireLevel } from '@intafaced/market-data';
import { DepthHub } from '../depth/hub.js';
import type { DepthSource } from '../depth/source.js';
import { DropCopyHub } from '../drop-copy/hub.js';
import { createDropCopyWebSocketGateway, DROP_COPY_STREAM_PATH } from '../drop-copy/gateway.js';
import { PrivateOrderHub, type PrivateOrderUpdate } from '../private/hub.js';
import { createPrivateWebSocketGateway, PRIVATE_STREAM_PATH } from '../private/gateway.js';
import { TradeHub } from '../trade/hub.js';
import { createWebSocketGateway, STREAM_PATH } from './gateway.js';

const SECRET = 'test-access-secret-at-least-32-chars!!';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MARKET = 'BTC-USDT';

const tokens: TokenConfig = {
  secret: SECRET,
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

class StubSource implements DepthSource {
  async markets(): Promise<readonly string[]> {
    return [MARKET];
  }
  async snapshot(marketId: string, _limit: number): Promise<DepthSnapshot> {
    const bids: readonly WireLevel[] = [['100', '1']];
    const asks: readonly WireLevel[] = [['101', '1']];
    return { type: 'snapshot', marketId, sequence: 1, bids, asks };
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

function mountHubs(log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }) {
  const source = new StubSource();
  const depthHub = new DepthHub(
    source,
    {
      depthLimit: 50,
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 4,
      marketsRefreshMs: 0,
    },
    log,
  );
  const tradeHub = new TradeHub(
    {
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 4,
      recentLimit: 10,
      ensureKnownMarket: (id) => depthHub.ensureKnownMarket(id),
    },
    log,
  );
  const privateHub = new PrivateOrderHub(
    {
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 4,
      maxConnectionsPerUser: 4,
    },
    log,
  );
  const dropCopyHub = new DropCopyHub(
    {
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 4,
      maxConnectionsPerUser: 4,
      recentLimit: 10,
    },
    log,
  );
  return { source, depthHub, tradeHub, privateHub, dropCopyHub };
}

describe('public + private WS co-mount (production shape)', () => {
  let server: Server;
  const log = { info: vi.fn(), warn: vi.fn() };

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('public depth delivers a real snapshot while both private doors lack authority configuration', async () => {
    server = createServer();
    const { depthHub, tradeHub, privateHub, dropCopyHub } = mountHubs(log);
    const common = { server, heartbeatMs: 30000, log, enabled: () => true };
    const publicGateway = createWebSocketGateway({ ...common, hub: depthHub, tradeHub });
    const privateGateway = createPrivateWebSocketGateway({ ...common, hub: privateHub, tokens, authority: null });
    const dropGateway = createDropCopyWebSocketGateway({ ...common, hub: dropCopyHub, tokens, authority: null });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('No test port');
    const base = `ws://127.0.0.1:${addr.port}`;
    const { token } = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:read'] }, tokens);
    try {
      expect(await upgradeStatus(`${base}${PRIVATE_STREAM_PATH}?access_token=${token}`)).toBe(503);
      expect(await upgradeStatus(`${base}${DROP_COPY_STREAM_PATH}?access_token=${token}`)).toBe(503);
      const client = new WebSocket(`${base}${STREAM_PATH}?market=${MARKET}`);
      const snapshot = await new Promise<Record<string, unknown>>((resolve, reject) => {
        client.on('message', (data) => resolve(JSON.parse(String(data))));
        client.once('error', reject);
      });
      expect(snapshot).toMatchObject({ type: 'snapshot', marketId: MARKET, bids: [['100', '1']], asks: [['101', '1']] });
      client.terminate();
    } finally {
      await privateGateway.close('test done');
      await dropGateway.close('test done');
      await publicGateway.close('test done');
    }
  });

  it('private stream reaches auth (401 without token); public stream still works', async () => {
    server = createServer();
    const { depthHub, tradeHub, privateHub, dropCopyHub } = mountHubs(log);

    createWebSocketGateway({
      server,
      hub: depthHub,
      tradeHub,
      heartbeatMs: 30_000,
      log,
      enabled: () => true,
    });
    createPrivateWebSocketGateway({
      authority: TEST_AUTHORITY,
      server,
      hub: privateHub,
      heartbeatMs: 30_000,
      log,
      enabled: () => true,
      tokens,
    });
    createDropCopyWebSocketGateway({
      authority: TEST_AUTHORITY,
      server,
      hub: dropCopyHub,
      heartbeatMs: 30_000,
      log,
      enabled: () => true,
      tokens,
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no listen address');
    const base = `127.0.0.1:${addr.port}`;

    // Public market stream still upgrades.
    expect(await upgradeStatus(`ws://${base}${STREAM_PATH}?market=${MARKET}`)).toBe(101);

    // Private without token is private's 401 — not public's 404.
    expect(await upgradeStatus(`ws://${base}${PRIVATE_STREAM_PATH}`)).toBe(401);
    expect(await upgradeStatus(`ws://${base}${DROP_COPY_STREAM_PATH}`)).toBe(401);
    expect(DROP_COPY_STREAM_PATH).not.toBe(PRIVATE_STREAM_PATH);

    const { token } = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:read'] }, tokens);
    expect(await upgradeStatus(`ws://${base}${PRIVATE_STREAM_PATH}?access_token=${token}`)).toBe(101);
    expect(await upgradeStatus(`ws://${base}${DROP_COPY_STREAM_PATH}?access_token=${token}`)).toBe(101);

    // Unknown path still 404 from public demux.
    expect(await upgradeStatus(`ws://${base}/nope`)).toBe(404);
  });

  it('public stream ignores a junk access_token and still upgrades', async () => {
    server = createServer();
    const { depthHub, tradeHub, privateHub } = mountHubs(log);

    createWebSocketGateway({
      server,
      hub: depthHub,
      tradeHub,
      heartbeatMs: 30_000,
      log,
      enabled: () => true,
    });
    createPrivateWebSocketGateway({
      authority: TEST_AUTHORITY,
      server,
      hub: privateHub,
      heartbeatMs: 30_000,
      log,
      enabled: () => true,
      tokens,
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no listen address');
    const base = `127.0.0.1:${addr.port}`;

    // Public path never authenticates — a query token is noise, not a gate.
    expect(await upgradeStatus(`ws://${base}${STREAM_PATH}?market=${MARKET}&access_token=not-a-jwt`)).toBe(101);
  });

  it('kill-switch refuses both public and private upgrades with 503', async () => {
    server = createServer();
    const { depthHub, tradeHub, privateHub } = mountHubs(log);
    let enabled = false;

    createWebSocketGateway({
      server,
      hub: depthHub,
      tradeHub,
      heartbeatMs: 30_000,
      log,
      enabled: () => enabled,
    });
    createPrivateWebSocketGateway({
      authority: TEST_AUTHORITY,
      server,
      hub: privateHub,
      heartbeatMs: 30_000,
      log,
      enabled: () => enabled,
      tokens,
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no listen address');
    const base = `127.0.0.1:${addr.port}`;

    expect(await upgradeStatus(`ws://${base}${STREAM_PATH}?market=${MARKET}`)).toBe(503);

    const { token } = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:read'] }, tokens);
    expect(await upgradeStatus(`ws://${base}${PRIVATE_STREAM_PATH}?access_token=${token}`)).toBe(503);
  });

  it('private stream never serves public depth frames', async () => {
    server = createServer();
    const { depthHub, tradeHub, privateHub } = mountHubs(log);

    createWebSocketGateway({
      server,
      hub: depthHub,
      tradeHub,
      heartbeatMs: 30_000,
      log,
      enabled: () => true,
    });
    createPrivateWebSocketGateway({
      authority: TEST_AUTHORITY,
      server,
      hub: privateHub,
      heartbeatMs: 30_000,
      log,
      enabled: () => true,
      tokens,
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no listen address');
    const base = `127.0.0.1:${addr.port}`;

    const { token } = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:read'] }, tokens);
    const frames: Array<Record<string, unknown>> = [];
    const ws = new WebSocket(`ws://${base}${PRIVATE_STREAM_PATH}?access_token=${token}`);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for private ready')), 5_000);
      ws.on('message', (data) => {
        frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
        if (frames.some((f) => f.channel === 'orders' && f.type === 'snapshot')) {
          clearTimeout(t);
          resolve();
        }
      });
      ws.on('error', reject);
    });
    ws.terminate();

    // Private catalog + orders snapshot — never public depth bids/asks.
    expect(
      frames
        .filter((f) => f.type === 'ready')
        .map((f) => f.channel)
        .sort(),
    ).toEqual(['fills', 'orders', 'positions']);
    expect(frames.find((f) => f.channel === 'orders' && f.type === 'snapshot')).toMatchObject({ orders: [] });
    for (const f of frames) {
      expect(f).not.toHaveProperty('bids');
      expect(f).not.toHaveProperty('asks');
      expect(f).not.toHaveProperty('sequence');
    }
  });

  it('malformed Host does not clobber a public /stream upgrade', async () => {
    server = createServer();
    const { depthHub, tradeHub, privateHub } = mountHubs(log);

    createWebSocketGateway({
      server,
      hub: depthHub,
      tradeHub,
      heartbeatMs: 30_000,
      log,
      enabled: () => true,
    });
    createPrivateWebSocketGateway({
      authority: TEST_AUTHORITY,
      server,
      hub: privateHub,
      heartbeatMs: 30_000,
      log,
      enabled: () => true,
      tokens,
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no listen address');
    const base = `127.0.0.1:${addr.port}`;

    // Hostile Host that would throw if private parsed `new URL(..., http://${host})`.
    // Public path must still open and receive a depth snapshot.
    const frames: unknown[] = [];
    const ws = new WebSocket(`ws://${base}${STREAM_PATH}?market=${MARKET}`, {
      headers: { Host: 'a b' },
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('public stream never delivered a frame')), 5_000);
      ws.on('message', (data) => {
        frames.push(JSON.parse(data.toString()));
        clearTimeout(t);
        resolve();
      });
      ws.on('close', () => {
        if (frames.length === 0) {
          clearTimeout(t);
          reject(new Error(`public stream closed before frame: ${JSON.stringify(ws)}`));
        }
      });
      ws.on('error', (err) => {
        clearTimeout(t);
        reject(err);
      });
    });
    ws.terminate();

    expect(frames[0]).toMatchObject({ type: 'snapshot', marketId: MARKET });
  });

  it('unreadable upgrade URL is refused with 400 and does not hang the socket', async () => {
    server = createServer();
    const { depthHub, tradeHub, privateHub } = mountHubs(log);

    createWebSocketGateway({
      server,
      hub: depthHub,
      tradeHub,
      heartbeatMs: 30_000,
      log,
      enabled: () => true,
    });
    createPrivateWebSocketGateway({
      authority: TEST_AUTHORITY,
      server,
      hub: privateHub,
      heartbeatMs: 30_000,
      log,
      enabled: () => true,
      tokens,
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no listen address');
    const port = addr.port;

    // Craft a raw HTTP upgrade whose request-target makes `new URL(req.url, base)` throw
    // (absolute-form with a broken IPv6 host). Both gateways must reject with 400, not hang.
    const { createConnection } = await import('node:net');
    const status = await new Promise<number>((resolve, reject) => {
      const sock = createConnection({ host: '127.0.0.1', port }, () => {
        // Absolute-form target with unclosed IPv6 bracket — URL constructor throws.
        sock.write(
          'GET http://[broken HTTP/1.1\r\n' +
            'Host: 127.0.0.1\r\n' +
            'Connection: Upgrade\r\n' +
            'Upgrade: websocket\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
            'Sec-WebSocket-Version: 13\r\n' +
            '\r\n',
        );
      });
      let buf = '';
      const t = setTimeout(() => {
        sock.destroy();
        reject(new Error('upgrade hung — no HTTP response for unreadable URL'));
      }, 2_000);
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const m = /^HTTP\/1\.\d\s+(\d+)/.exec(buf);
        if (m) {
          clearTimeout(t);
          sock.destroy();
          resolve(Number(m[1]));
        }
      });
      sock.on('error', (err) => {
        clearTimeout(t);
        reject(err);
      });
    });

    expect(status).toBe(400);

    // Peer path still works after the bad upgrade (co-mount isolation / listener health).
    const ok = await upgradeStatus(`ws://127.0.0.1:${port}${STREAM_PATH}?market=${MARKET}`);
    expect(ok).toBe(101);
  });

  it('private order frames never land on a public depth socket', async () => {
    server = createServer();
    const { depthHub, tradeHub, privateHub } = mountHubs(log);

    createWebSocketGateway({
      server,
      hub: depthHub,
      tradeHub,
      heartbeatMs: 30_000,
      log,
      enabled: () => true,
    });
    createPrivateWebSocketGateway({
      authority: TEST_AUTHORITY,
      server,
      hub: privateHub,
      heartbeatMs: 30_000,
      log,
      enabled: () => true,
      tokens,
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no listen address');
    const base = `127.0.0.1:${addr.port}`;

    const publicFrames: Array<Record<string, unknown>> = [];
    const pub = new WebSocket(`ws://${base}${STREAM_PATH}?market=${MARKET}`);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no public snapshot')), 5_000);
      pub.on('message', (data) => {
        publicFrames.push(JSON.parse(data.toString()) as Record<string, unknown>);
        if (publicFrames.some((f) => f.type === 'snapshot')) {
          clearTimeout(t);
          resolve();
        }
      });
      pub.on('error', reject);
    });

    const privateOrder: PrivateOrderUpdate = {
      orderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: USER,
      marketId: MARKET,
      status: 'open',
      side: 'buy',
      type: 'limit',
      qty: '1',
      filledQty: '0',
      price: '100',
      clientOrderId: null,
      ts: '2026-08-09T00:00:00.000Z',
    };
    privateHub.publish(privateOrder);

    await new Promise((r) => setTimeout(r, 50));
    pub.terminate();

    expect(publicFrames.every((f) => f.type === 'snapshot' || f.type === 'delta')).toBe(true);
    expect(publicFrames.some((f) => f.channel === 'orders' || f.type === 'orderUpdated')).toBe(false);
  });
});
