import { TEST_AUTHORITY } from '../test-support/authority.js';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { PrivateOrderHub } from './hub.js';
import { CLOSE_UNAUTHORIZED, createPrivateWebSocketGateway, PRIVATE_STREAM_PATH, type PrivateWebSocketGateway } from './gateway.js';
import { LiveCredentialError, type LiveCredentialPort, type OwnershipSnapshot } from './live-credential.js';
import type { HubLogger } from '../depth/hub.js';

const SECRET = 'test-access-secret-at-least-32-chars!!';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RANGE = { minTtlMs: 50, maxTtlMs: 60_000 };

const tokens: TokenConfig = {
  secret: SECRET,
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

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

  async untilType(type: string): Promise<Record<string, unknown>> {
    for (;;) {
      const hit = this.parsed().find((f) => f.type === type);
      if (hit) return hit;
      if (this.closed) throw new Error(`closed before ${type}`);
      await this.frameCount(this.frames.length + 1);
    }
  }

  async untilSnapshot(): Promise<void> {
    for (;;) {
      if (this.parsed().some((f) => f.type === 'snapshot')) return;
      if (this.closed) throw new Error('closed before snapshot');
      await this.frameCount(this.frames.length + 1);
    }
  }
}

function mutablePort(initial: OwnershipSnapshot): LiveCredentialPort & { snap: OwnershipSnapshot | null; fail: Error | null } {
  const state: { snap: OwnershipSnapshot | null; fail: Error | null } = { snap: initial, fail: null };
  return {
    get snap() {
      return state.snap;
    },
    set snap(v) {
      state.snap = v;
    },
    get fail() {
      return state.fail;
    },
    set fail(v) {
      state.fail = v;
    },
    async getSession() {
      if (state.fail) throw state.fail;
      return state.snap;
    },
    async getApiKey() {
      if (state.fail) throw state.fail;
      return state.snap;
    },
  };
}

describe('private stream live-credential revoke', () => {
  let server: Server;
  let hub: PrivateOrderHub;
  let gateway: PrivateWebSocketGateway;
  let baseUrl: string;
  let httpHost: string;
  let httpPort: number;

  afterEach(async () => {
    await gateway?.close('test done');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function boot(opts: { liveCredential?: LiveCredentialPort | null; heartbeatMs?: number } = {}): Promise<void> {
    hub = new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 10, maxConnectionsPerUser: 10 });
    server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    httpHost = '127.0.0.1';
    httpPort = addr.port;
    baseUrl = `ws://127.0.0.1:${addr.port}`;
    const log: HubLogger = { info: () => undefined, warn: () => undefined };
    gateway = createPrivateWebSocketGateway({
      authority: TEST_AUTHORITY,
      server,
      hub,
      heartbeatMs: opts.heartbeatMs ?? 30_000,
      log,
      enabled: () => true,
      tokens,
      liveCredential: opts.liveCredential,
      codRange: RANGE,
    });
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

  async function token(extra: { apiKeyId?: string } = {}): Promise<string> {
    const issued = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:write'], ...extra }, tokens);
    return issued.token;
  }

  it('revoked session refuses upgrade with HTTP 401 and no ready frames', async () => {
    const live = mutablePort({ id: SESSION, userId: USER, revoked: true });
    await boot({ liveCredential: live });
    const access = await token();
    expect(await upgradeStatus(`${PRIVATE_STREAM_PATH}?access_token=${access}`)).toBe(401);
    const client = new Client(`${baseUrl}${PRIVATE_STREAM_PATH}?access_token=${access}`);
    await new Promise<void>((resolve) => {
      client.socket.once('close', () => resolve());
      client.socket.once('error', () => resolve());
      setTimeout(resolve, 500);
    });
    expect(client.parsed().some((f) => f.type === 'ready')).toBe(false);
    expect(client.frames).toEqual([]);
  });

  it('revoked API key (kid) refuses upgrade with HTTP 401', async () => {
    const live = mutablePort({ id: KEY, userId: USER, revoked: true });
    await boot({ liveCredential: live });
    const access = await token({ apiKeyId: KEY });
    expect(await upgradeStatus(`${PRIVATE_STREAM_PATH}?access_token=${access}`)).toBe(401);
  });

  it('unknown id and unavailable fail-closed on upgrade (401), never stay live', async () => {
    await boot({
      liveCredential: {
        async getSession() {
          return null;
        },
        async getApiKey() {
          return null;
        },
      },
    });
    const access = await token();
    expect(await upgradeStatus(`${PRIVATE_STREAM_PATH}?access_token=${access}`)).toBe(401);

    await gateway.close('reset');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await boot({
      liveCredential: {
        async getSession() {
          throw new LiveCredentialError('down', 'unavailable');
        },
        async getApiKey() {
          throw new LiveCredentialError('down', 'unavailable');
        },
      },
    });
    expect(await upgradeStatus(`${PRIVATE_STREAM_PATH}?access_token=${access}`)).toBe(401);
  });

  it('live connect, arm COD, then revoke + heartbeat drops lease without firing', async () => {
    const live = mutablePort({ id: SESSION, userId: USER, revoked: false });
    await boot({ liveCredential: live, heartbeatMs: 500 });
    const access = await token();
    const client = new Client(`${baseUrl}${PRIVATE_STREAM_PATH}?access_token=${access}`);
    await client.untilSnapshot();
    const waiter = new Client(`${baseUrl}${PRIVATE_STREAM_PATH}?access_token=${access}`);
    await waiter.untilSnapshot();
    client.socket.send(JSON.stringify({ type: 'cod.arm', commandId: 'c1', ttlMs: 30_000, scope: 'account' }));
    await client.untilType('cod.armed');
    expect(gateway.armedCount).toBe(1);

    live.snap = { id: SESSION, userId: USER, revoked: true };
    const closed = new Promise<void>((resolve) => {
      if (client.closed) {
        resolve();
        return;
      }
      client.socket.once('close', () => resolve());
    });
    await Promise.race([closed, new Promise<void>((r) => setTimeout(r, 2_000))]);
    expect(client.closed).not.toBeNull();
    expect(client.closed!.code).toBe(CLOSE_UNAUTHORIZED);
    expect(client.parsed().some((f) => f.type === 'cod.fired')).toBe(false);
    expect(waiter.parsed().some((f) => f.type === 'cod.fired')).toBe(false);
    expect(gateway.armedCount).toBe(0);
    waiter.socket.close();
  });

  it('live connect, arm COD, then revoke + renew message drops lease without firing', async () => {
    const live = mutablePort({ id: SESSION, userId: USER, revoked: false });
    await boot({ liveCredential: live });
    const access = await token();
    const client = new Client(`${baseUrl}${PRIVATE_STREAM_PATH}?access_token=${access}`);
    await client.untilSnapshot();
    const waiter = new Client(`${baseUrl}${PRIVATE_STREAM_PATH}?access_token=${access}`);
    await waiter.untilSnapshot();
    client.socket.send(JSON.stringify({ type: 'cod.arm', commandId: 'c1', ttlMs: 30_000, scope: 'account' }));
    await client.untilType('cod.armed');
    expect(gateway.armedCount).toBe(1);

    live.snap = { id: SESSION, userId: USER, revoked: true };
    client.socket.send(JSON.stringify({ type: 'cod.renew', commandId: 'c1' }));
    const closed = new Promise<void>((resolve) => {
      if (client.closed) {
        resolve();
        return;
      }
      client.socket.once('close', () => resolve());
    });
    await Promise.race([closed, new Promise<void>((r) => setTimeout(r, 2_000))]);
    expect(client.closed).not.toBeNull();
    expect(client.closed!.code).toBe(CLOSE_UNAUTHORIZED);
    expect(client.parsed().some((f) => f.type === 'cod.fired')).toBe(false);
    expect(waiter.parsed().some((f) => f.type === 'cod.fired')).toBe(false);
    expect(gateway.armedCount).toBe(0);
    waiter.socket.close();
  });

  it('unavailable on a live seat fail-closes 4003 and drops the lease', async () => {
    const live = mutablePort({ id: SESSION, userId: USER, revoked: false });
    await boot({ liveCredential: live });
    const access = await token();
    const client = new Client(`${baseUrl}${PRIVATE_STREAM_PATH}?access_token=${access}`);
    await client.untilSnapshot();
    client.socket.send(JSON.stringify({ type: 'cod.arm', commandId: 'c1', ttlMs: 30_000, scope: 'account' }));
    await client.untilType('cod.armed');
    live.fail = new LiveCredentialError('down', 'unavailable');
    client.socket.send(JSON.stringify({ type: 'cod.renew', commandId: 'c1' }));
    const closed = new Promise<void>((resolve) => {
      if (client.closed) {
        resolve();
        return;
      }
      client.socket.once('close', () => resolve());
    });
    await Promise.race([closed, new Promise<void>((r) => setTimeout(r, 2_000))]);
    expect(client.closed?.code).toBe(CLOSE_UNAUTHORIZED);
    expect(client.parsed().some((f) => f.type === 'cod.fired')).toBe(false);
    expect(gateway.armedCount).toBe(0);
  });

  it('explicit authority accepts a live JWT without an optional supplemental adapter', async () => {
    await boot();
    const access = await token();
    expect(await upgradeStatus(`${PRIVATE_STREAM_PATH}?access_token=${access}`)).toBe(101);
    const client = new Client(`${baseUrl}${PRIVATE_STREAM_PATH}?access_token=${access}`);
    await client.untilSnapshot();
    expect(client.parsed().some((f) => f.type === 'ready')).toBe(true);
    client.socket.close();
  });
});
