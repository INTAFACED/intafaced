import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { PRIVATE_STREAM_PATH } from '../private/gateway.js';
import type { LiveCredentialPort, OwnershipSnapshot } from '../private/live-credential.js';
import { DROP_COPY_CHANNEL, DropCopyHub } from './hub.js';
import {
  CLOSE_UNAUTHORIZED,
  createDropCopyWebSocketGateway,
  DROP_COPY_STREAM_PATH,
  type DropCopyWebSocketGateway,
} from './gateway.js';

const SECRET = 'test-access-secret-at-least-32-chars!!';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const tokens: TokenConfig = {
  secret: SECRET,
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const HEARTBEAT_MS = 30_000;

/** Heartbeat only. Leave nextTick and setImmediate real so the socket can open. */
const FAKE_CLOCK = {
  toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
} as const;

async function yieldIo(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function liveCredential(): LiveCredentialPort & { revoke(): void } {
  const state = { revoked: false };
  return {
    revoke() {
      state.revoked = true;
    },
    async getSession(): Promise<OwnershipSnapshot> {
      return { id: SESSION, userId: USER, revoked: state.revoked };
    },
    async getApiKey(): Promise<OwnershipSnapshot> {
      return { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', userId: USER, revoked: false };
    },
  };
}

class Client {
  readonly socket: WebSocket;
  readonly frames: string[] = [];
  closed: { code: number; reason: string } | null = null;
  readonly #waiters: Array<{ count: number; resolve: () => void }> = [];

  constructor(url: string, opts?: { autoPong?: boolean }) {
    this.socket = new WebSocket(url, opts?.autoPong === false ? { autoPong: false } : undefined);
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

  untilClosed(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      this.socket.once('close', () => resolve());
    });
  }

  parsed(): Array<Record<string, unknown>> {
    return this.frames.map((f) => JSON.parse(f) as Record<string, unknown>);
  }
}

describe('drop-copy WebSocket gateway', () => {
  let server: Server | undefined;
  let hub: DropCopyHub;
  let gateway: DropCopyWebSocketGateway | undefined;
  let baseUrl: string;
  let httpHost: string;
  let httpPort: number;
  let enabled = true;

  afterEach(async () => {
    enabled = true;
    await gateway?.close('test done');
    if (server) {
      const closing = server;
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    }
  });

  async function boot(
    opts: {
      tokens: TokenConfig | null;
      liveCredential?: LiveCredentialPort | null;
      heartbeatMs?: number;
      maxConnectionsPerUser?: number;
    } = { tokens },
  ): Promise<void> {
    hub = new DropCopyHub({
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 10,
      maxConnectionsPerUser: opts.maxConnectionsPerUser ?? 10,
      recentLimit: 10,
    });
    hub.announceBus(true);
    const http = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    server = http;
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
    const addr = http.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    httpHost = '127.0.0.1';
    httpPort = addr.port;
    baseUrl = `ws://127.0.0.1:${addr.port}`;
    gateway = createDropCopyWebSocketGateway({
      server: http,
      hub,
      heartbeatMs: opts.heartbeatMs ?? 30_000,
      log: { info: () => undefined, warn: () => undefined },
      enabled: () => enabled,
      tokens: opts.tokens,
      liveCredential: opts.liveCredential ?? null,
    });
  }

  async function accessToken(scopes: string[]): Promise<string> {
    const { token } = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes }, tokens);
    return token;
  }

  function upgradeStatus(path: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: httpHost,
          port: httpPort,
          path,
          method: 'GET',
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
        },
      );
      req.on('upgrade', (_res, socket) => {
        socket.destroy();
        resolve(101);
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('is not the trading private path', () => {
    expect(DROP_COPY_STREAM_PATH).not.toBe(PRIVATE_STREAM_PATH);
    expect(DROP_COPY_CHANNEL).not.toBe('fills');
    expect(DROP_COPY_CHANNEL).not.toBe('orders');
  });

  it('rejects upgrade without a token with HTTP 401', async () => {
    await boot();
    expect(await upgradeStatus(DROP_COPY_STREAM_PATH)).toBe(401);
  });

  it('rejects trading channels on the drop-copy path with HTTP 400', async () => {
    await boot();
    const token = await accessToken(['trade:read']);
    expect(await upgradeStatus(`${DROP_COPY_STREAM_PATH}?access_token=${token}&channel=fills`)).toBe(400);
    expect(await upgradeStatus(`${DROP_COPY_STREAM_PATH}?access_token=${token}&channel=orders`)).toBe(400);
  });

  it('ignores inbound place/cancel JSON — no ack, no invented execution', async () => {
    await boot();
    const token = await accessToken(['trade:read']);
    const client = new Client(`${baseUrl}${DROP_COPY_STREAM_PATH}?access_token=${token}`);
    await client.frameCount(2);
    const before = client.frames.length;
    client.socket.send(JSON.stringify({ type: 'place', marketId: 'btc-usdt', qty: '1', price: '100' }));
    client.socket.send(JSON.stringify({ type: 'cancel', orderId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }));
    await new Promise((r) => setTimeout(r, 80));
    expect(client.frames.length).toBe(before);
    expect(client.parsed().some((f) => f.type === 'execution' || f.type === 'ack')).toBe(false);
    expect(client.closed).toBeNull();
  });

  it('delivers an execution on drop_copy after connect watermark', async () => {
    await boot();
    const token = await accessToken(['trade:read']);
    const client = new Client(`${baseUrl}${DROP_COPY_STREAM_PATH}?access_token=${token}`);
    await client.frameCount(2);
    expect(client.parsed().some((f) => f.channel === DROP_COPY_CHANNEL && f.type === 'ready')).toBe(true);
    expect(client.parsed().some((f) => f.completeness === 'complete')).toBe(false);

    hub.publishExecution({
      fillId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      orderId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      userId: USER,
      marketId: 'btc-usdt',
      side: 'buy',
      liquidity: 'taker',
      price: '99.5',
      qty: '0.2',
      quoteAmount: '19.9',
      feeAsset: 'USDT',
      feeAmount: '0.02',
      engineSequence: 3,
      ts: '2026-07-31T00:00:00.000Z',
    });
    await client.frameCount(client.frames.length + 1);
    const exec = client.parsed().find((f) => f.type === 'execution');
    expect(exec).toMatchObject({
      channel: DROP_COPY_CHANNEL,
      dropCopySeq: 1,
      price: '99.5',
      qty: '0.2',
      feeAmount: '0.02',
    });
  });

  it('terminates a live-credential seat that misses a pong and frees the per-user ceiling', async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      const credential = liveCredential();
      await boot({ tokens, liveCredential: credential, heartbeatMs: HEARTBEAT_MS, maxConnectionsPerUser: 1 });
      const token = await accessToken(['trade:read']);
      const url = `${baseUrl}${DROP_COPY_STREAM_PATH}?access_token=${token}`;
      const dead = new Client(url, { autoPong: false });
      let pings = 0;
      dead.socket.on('ping', () => {
        pings += 1;
      });
      await dead.frameCount(2);
      expect(hub.connections).toBe(1);
      expect(dead.closed).toBeNull();

      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      await yieldIo();
      expect(pings).toBe(1);
      expect(dead.closed).toBeNull();
      expect(hub.connections).toBe(1);

      const blocked = new Client(url, { autoPong: false });
      await blocked.untilClosed();
      expect(hub.connections).toBe(1);
      expect(blocked.parsed().some((frame) => frame.type === 'ready')).toBe(false);

      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      await yieldIo();
      expect(pings).toBe(1);
      expect(dead.closed).not.toBeNull();
      expect(hub.connections).toBe(0);

      const next = new Client(url);
      await next.frameCount(2);
      expect(next.closed).toBeNull();
      expect(next.parsed().some((frame) => frame.type === 'ready')).toBe(true);
      expect(hub.connections).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pings a live-credential seat on the first heartbeat and keeps it', async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      await boot({
        tokens,
        liveCredential: liveCredential(),
        heartbeatMs: HEARTBEAT_MS,
        maxConnectionsPerUser: 1,
      });
      const token = await accessToken(['trade:read']);
      const url = `${baseUrl}${DROP_COPY_STREAM_PATH}?access_token=${token}`;
      const seat = new Client(url, { autoPong: false });
      let pings = 0;
      seat.socket.on('ping', () => {
        pings += 1;
      });
      await seat.frameCount(2);
      expect(hub.connections).toBe(1);

      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      await yieldIo();
      expect(pings).toBe(1);
      expect(seat.closed).toBeNull();
      expect(hub.connections).toBe(1);

      const blocked = new Client(url, { autoPong: false });
      await blocked.untilClosed();
      expect(hub.connections).toBe(1);
      expect(blocked.parsed().some((frame) => frame.type === 'ready')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a live-credential seat when a pong arrives before the next heartbeat', async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      await boot({
        tokens,
        liveCredential: liveCredential(),
        heartbeatMs: HEARTBEAT_MS,
        maxConnectionsPerUser: 1,
      });
      const token = await accessToken(['trade:read']);
      const url = `${baseUrl}${DROP_COPY_STREAM_PATH}?access_token=${token}`;
      const seat = new Client(url, { autoPong: false });
      let pings = 0;
      seat.socket.on('ping', () => {
        pings += 1;
        seat.socket.pong();
      });
      await seat.frameCount(2);
      expect(hub.connections).toBe(1);

      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      await yieldIo();
      expect(pings).toBe(1);
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      await yieldIo();

      expect(pings).toBe(2);
      expect(seat.closed).toBeNull();
      expect(hub.connections).toBe(1);
      const blocked = new Client(url, { autoPong: false });
      await blocked.untilClosed();
      expect(hub.connections).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes 4003 when a live credential fails on heartbeat', async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      const credential = liveCredential();
      await boot({ tokens, liveCredential: credential, heartbeatMs: HEARTBEAT_MS, maxConnectionsPerUser: 1 });
      const token = await accessToken(['trade:read']);
      const url = `${baseUrl}${DROP_COPY_STREAM_PATH}?access_token=${token}`;
      const seat = new Client(url);
      await seat.frameCount(2);
      expect(hub.connections).toBe(1);

      credential.revoke();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      await yieldIo();

      expect(seat.closed?.code).toBe(CLOSE_UNAUTHORIZED);
      expect(hub.connections).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
