import { TEST_AUTHORITY } from '../test-support/authority.js';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { DropCopyHub } from './hub.js';
import { CLOSE_UNAUTHORIZED, createDropCopyWebSocketGateway, DROP_COPY_STREAM_PATH, type DropCopyWebSocketGateway } from './gateway.js';
import type { LiveCredentialPort, OwnershipSnapshot } from '../private/live-credential.js';
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
};

function flippingPort(): FlippingPort {
  const state = { sessionRevoked: false, keyRevoked: false };
  return {
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
      return { id: SESSION, userId: USER, revoked: state.sessionRevoked };
    },
    async getApiKey(): Promise<OwnershipSnapshot> {
      return { id: KEY, userId: USER, revoked: state.keyRevoked };
    },
  };
}

describe('drop-copy stream drops when the API key is revoked', () => {
  let server: Server;
  let gateway: DropCopyWebSocketGateway;

  afterEach(async () => {
    await gateway?.close('test done');
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function boot(liveCredential: LiveCredentialPort, heartbeatMs = 30_000): Promise<{ host: string; port: number }> {
    const hub = new DropCopyHub({
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 10,
      maxConnectionsPerUser: 10,
      recentLimit: 10,
    });
    server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const log: HubLogger = { info: () => undefined, warn: () => undefined };
    gateway = createDropCopyWebSocketGateway({
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

  function connect(port: number, token: string): { ws: WebSocket; closed: { code: number } | null; opened: boolean } {
    const seat: { ws: WebSocket; closed: { code: number } | null; opened: boolean } = {
      ws: null as unknown as WebSocket,
      closed: null,
      opened: false,
    };
    const ws = new WebSocket(`ws://127.0.0.1:${port}${DROP_COPY_STREAM_PATH}?access_token=${token}`);
    seat.ws = ws;
    ws.on('error', () => undefined);
    ws.on('open', () => {
      seat.opened = true;
    });
    ws.on('close', (code) => {
      seat.closed = { code };
    });
    return seat;
  }

  async function untilOpen(seat: { opened: boolean; closed: { code: number } | null }): Promise<void> {
    await new Promise<void>((resolve) => {
      const tick = setInterval(() => {
        if (seat.opened || seat.closed) {
          clearTimeout(timer);
          clearInterval(tick);
          resolve();
        }
      }, 10);
      const timer = setTimeout(() => {
        clearInterval(tick);
        resolve();
      }, 500);
    });
  }

  it('live key upgrades; revoked key refuses with 401', async () => {
    const port = flippingPort();
    const { host, port: listen } = await boot(port);
    const token = await access(KEY);
    expect(await upgradeStatus(host, listen, `${DROP_COPY_STREAM_PATH}?access_token=${token}`)).toBe(101);
    port.keyRevoked = true;
    expect(await upgradeStatus(host, listen, `${DROP_COPY_STREAM_PATH}?access_token=${token}`)).toBe(401);
  });

  it('a still-live key stays open across heartbeats', async () => {
    const { port: listen } = await boot(flippingPort(), 40);
    const token = await access(KEY);
    const seat = connect(listen, token);
    await untilOpen(seat);
    expect(seat.opened).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(seat.closed).toBeNull();
    seat.ws.terminate();
  });

  it('a live key seat drops on the next heartbeat after identity revokes the key', async () => {
    const port = flippingPort();
    const { port: listen } = await boot(port, 40);
    const token = await access(KEY);
    const seat = connect(listen, token);
    await untilOpen(seat);
    expect(seat.opened).toBe(true);
    port.keyRevoked = true;
    await new Promise<void>((resolve) => {
      if (seat.closed) {
        resolve();
        return;
      }
      seat.ws.once('close', () => resolve());
      setTimeout(resolve, 2_000);
    });
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
    await untilOpen(sessionSeat);
    await untilOpen(keySeat);
    expect(sessionSeat.opened).toBe(true);
    expect(keySeat.opened).toBe(true);
    port.keyRevoked = true;
    await new Promise<void>((resolve) => {
      if (keySeat.closed) {
        resolve();
        return;
      }
      keySeat.ws.once('close', () => resolve());
      setTimeout(resolve, 2_000);
    });
    expect(keySeat.closed?.code).toBe(CLOSE_UNAUTHORIZED);
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(sessionSeat.closed).toBeNull();
    sessionSeat.ws.terminate();
    keySeat.ws.terminate();
  });

  it('a live session seat still drops when the session is revoked', async () => {
    const port = flippingPort();
    const { port: listen } = await boot(port, 40);
    const token = await access();
    const seat = connect(listen, token);
    await untilOpen(seat);
    expect(seat.opened).toBe(true);
    port.sessionRevoked = true;
    await new Promise<void>((resolve) => {
      if (seat.closed) {
        resolve();
        return;
      }
      seat.ws.once('close', () => resolve());
      setTimeout(resolve, 2_000);
    });
    expect(seat.closed).not.toBeNull();
    expect(seat.closed!.code).toBe(CLOSE_UNAUTHORIZED);
    seat.ws.terminate();
  });
});
