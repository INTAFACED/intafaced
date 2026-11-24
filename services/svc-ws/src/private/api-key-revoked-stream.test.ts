import { TEST_AUTHORITY } from '../test-support/authority.js';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { PrivateOrderHub } from './hub.js';
import { CLOSE_UNAUTHORIZED, createPrivateWebSocketGateway, PRIVATE_STREAM_PATH, type PrivateWebSocketGateway } from './gateway.js';
import type { LiveCredentialPort, OwnershipSnapshot } from './live-credential.js';
import type { HubLogger } from '../depth/hub.js';

const SECRET = 'test-access-secret-at-least-32-chars!!';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const tokens: TokenConfig = {
  secret: SECRET,
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

type FlippingPort = LiveCredentialPort & {
  sessionRevoked: boolean;
  keyRevoked: boolean;
  /** How many times the gateway has asked identity about a session or a key: each heartbeat asks once per seat. */
  readonly checks: { session: number; key: number };
};

function flippingPort(): FlippingPort {
  const state = { sessionRevoked: false, keyRevoked: false };
  const checks = { session: 0, key: 0 };
  return {
    checks,
    get sessionRevoked() {
      return state.sessionRevoked;
    },
    set sessionRevoked(v) {
      state.sessionRevoked = v;
    },
    get keyRevoked() {
      return state.keyRevoked;
    },
    set keyRevoked(v) {
      state.keyRevoked = v;
    },
    async getSession(): Promise<OwnershipSnapshot> {
      checks.session += 1;
      return { id: SESSION, userId: USER, revoked: state.sessionRevoked };
    },
    async getApiKey(): Promise<OwnershipSnapshot> {
      checks.key += 1;
      return { id: KEY, userId: USER, revoked: state.keyRevoked };
    },
  };
}

describe('private stream drops when the API key is revoked', () => {
  let server: Server;
  let gateway: PrivateWebSocketGateway;

  afterEach(async () => {
    await gateway?.close('test done');
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function boot(liveCredential: LiveCredentialPort, heartbeatMs = 30_000): Promise<{ host: string; port: number }> {
    const hub = new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 10, maxConnectionsPerUser: 10 });
    server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const log: HubLogger = { info: () => undefined, warn: () => undefined };
    gateway = createPrivateWebSocketGateway({
      authority: TEST_AUTHORITY,
      server,
      hub,
      heartbeatMs,
      log,
      enabled: () => true,
      tokens,
      liveCredential,
    });
    return { host: '127.0.0.1', port: addr.port };
  }

  async function access(apiKeyId?: string): Promise<string> {
    const issued = await issueAccessToken(
      { userId: USER, sessionId: SESSION, scopes: ['trade:write'], ...(apiKeyId ? { apiKeyId } : {}) },
      tokens,
    );
    return issued.token;
  }

  function upgradeStatus(host: string, port: number, path: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      };
      const req = httpRequest({ host, port, path, method: 'GET', headers }, (res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
      });
      req.on('upgrade', (_res, socket) => {
        socket.destroy();
        resolve(101);
      });
      req.on('error', reject);
      req.end();
    });
  }

  function connect(port: number, token: string): { ws: WebSocket; frames: string[]; closed: { code: number } | null } {
    const frames: string[] = [];
    const seat: { ws: WebSocket; frames: string[]; closed: { code: number } | null } = {
      ws: null as unknown as WebSocket,
      frames,
      closed: null,
    };
    const ws = new WebSocket(`ws://127.0.0.1:${port}${PRIVATE_STREAM_PATH}?access_token=${token}`);
    seat.ws = ws;
    ws.on('message', (data) => frames.push(data.toString()));
    ws.on('error', () => undefined);
    ws.on('close', (code) => {
      seat.closed = { code };
    });
    return seat;
  }

  async function untilReady(seat: { frames: string[]; closed: { code: number } | null }): Promise<void> {
    await vi.waitFor(() => expect(seat.frames.some((f) => f.includes('"type":"ready"')) || seat.closed !== null).toBe(true), {
      timeout: 500,
    });
  }

  it('live key upgrades; revoked key refuses with 401', async () => {
    const port = flippingPort();
    const { host, port: listen } = await boot(port);
    const token = await access(KEY);
    expect(await upgradeStatus(host, listen, `${PRIVATE_STREAM_PATH}?access_token=${token}`)).toBe(101);
    port.keyRevoked = true;
    expect(await upgradeStatus(host, listen, `${PRIVATE_STREAM_PATH}?access_token=${token}`)).toBe(401);
  });

  it('a still-live key stays open across heartbeats', async () => {
    const port = flippingPort();
    const { port: listen } = await boot(port, 40);
    const token = await access(KEY);
    const seat = connect(listen, token);
    await untilReady(seat);
    expect(seat.frames.some((f) => f.includes('"type":"ready"'))).toBe(true);
    const asked = port.checks.key;
    await vi.waitFor(() => expect(port.checks.key).toBeGreaterThanOrEqual(asked + 3), { timeout: 2_000 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(seat.closed).toBeNull();
    seat.ws.terminate();
  });

  it('a live key seat drops on the next heartbeat after identity revokes the key', async () => {
    const port = flippingPort();
    const { port: listen } = await boot(port, 40);
    const token = await access(KEY);
    const seat = connect(listen, token);
    await untilReady(seat);
    expect(seat.frames.some((f) => f.includes('"type":"ready"'))).toBe(true);
    port.keyRevoked = true;
    await vi.waitFor(() => expect(seat.closed).not.toBeNull(), { timeout: 2_000 });
    expect(seat.closed).not.toBeNull();
    expect(seat.closed!.code).toBe(CLOSE_UNAUTHORIZED);
    seat.ws.terminate();
  });

  it('a session seat is not dropped when the API-key snapshot is revoked', async () => {
    const port = flippingPort();
    const { port: listen } = await boot(port, 40);
    const sessionToken = await access();
    const keyToken = await access(KEY);
    const sessionSeat = connect(listen, sessionToken);
    const keySeat = connect(listen, keyToken);
    await untilReady(sessionSeat);
    await untilReady(keySeat);
    expect(sessionSeat.frames.some((f) => f.includes('"type":"ready"'))).toBe(true);
    expect(keySeat.frames.some((f) => f.includes('"type":"ready"'))).toBe(true);
    port.keyRevoked = true;
    await vi.waitFor(() => expect(keySeat.closed).not.toBeNull(), { timeout: 2_000 });
    expect(keySeat.closed?.code).toBe(CLOSE_UNAUTHORIZED);
    const asked = port.checks.session;
    await vi.waitFor(() => expect(port.checks.session).toBeGreaterThanOrEqual(asked + 3), { timeout: 2_000 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sessionSeat.closed).toBeNull();
    sessionSeat.ws.terminate();
    keySeat.ws.terminate();
  });

  it('a live session seat still drops when the session is revoked', async () => {
    const port = flippingPort();
    const { port: listen } = await boot(port, 40);
    const token = await access();
    const seat = connect(listen, token);
    await untilReady(seat);
    expect(seat.frames.some((f) => f.includes('"type":"ready"'))).toBe(true);
    port.sessionRevoked = true;
    await vi.waitFor(() => expect(seat.closed).not.toBeNull(), { timeout: 2_000 });
    expect(seat.closed).not.toBeNull();
    expect(seat.closed!.code).toBe(CLOSE_UNAUTHORIZED);
    seat.ws.terminate();
  });
});
