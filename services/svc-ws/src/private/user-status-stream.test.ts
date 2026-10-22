import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { PrivateOrderHub } from './hub.js';
import { createPrivateWebSocketGateway, PRIVATE_STREAM_PATH, type PrivateWebSocketGateway } from './gateway.js';
import type { AccountStatusSnapshot, LiveCredentialPort, OwnershipSnapshot } from './live-credential.js';
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

function accountPort(status: AccountStatusSnapshot['status'] | null): LiveCredentialPort {
  const session: OwnershipSnapshot = { id: SESSION, userId: USER, revoked: false };
  const key: OwnershipSnapshot = { id: KEY, userId: USER, revoked: false };
  return {
    async getSession() {
      return session;
    },
    async getApiKey() {
      return key;
    },
    async getAccount() {
      return status === null
        ? null
        : { userId: USER, status, ...(status === 'active' ? { lastVerifiedAt: '2026-08-25T00:00:00.000Z' } : {}) };
    },
  };
}

describe('private stream drops when the user is frozen', () => {
  let server: Server;
  let gateway: PrivateWebSocketGateway;

  afterEach(async () => {
    await gateway?.close('test done');
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function boot(liveCredential: LiveCredentialPort, heartbeatMs = 30_000): Promise<{ host: string; port: number }> {
    const hub = new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 10 });
    server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const log: HubLogger = { info: () => undefined, warn: () => undefined };
    gateway = createPrivateWebSocketGateway({
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

  it('active user upgrades on session and API-key seats', async () => {
    const { host, port } = await boot(accountPort('active'));
    const session = await access();
    const key = await access(KEY);
    expect(await upgradeStatus(host, port, `${PRIVATE_STREAM_PATH}?access_token=${session}`)).toBe(101);
    expect(await upgradeStatus(host, port, `${PRIVATE_STREAM_PATH}?access_token=${key}`)).toBe(101);
  });

  it('frozen, closed, and missing account refuse with 401', async () => {
    const frozen = await boot(accountPort('frozen'));
    const token = await access();
    expect(await upgradeStatus(frozen.host, frozen.port, `${PRIVATE_STREAM_PATH}?access_token=${token}`)).toBe(401);
    await gateway.close('reset');
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const closed = await boot(accountPort('closed'));
    expect(await upgradeStatus(closed.host, closed.port, `${PRIVATE_STREAM_PATH}?access_token=${token}`)).toBe(401);
    await gateway.close('reset');
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const missing = await boot(accountPort(null));
    expect(await upgradeStatus(missing.host, missing.port, `${PRIVATE_STREAM_PATH}?access_token=${token}`)).toBe(401);
  });

  it('frozen API-key seat also refuses with 401', async () => {
    const { host, port } = await boot(accountPort('frozen'));
    const token = await access(KEY);
    expect(await upgradeStatus(host, port, `${PRIVATE_STREAM_PATH}?access_token=${token}`)).toBe(401);
  });

  it('frozen user never receives a ready frame', async () => {
    const { port: listen } = await boot(accountPort('frozen'));
    const token = await access();
    const frames: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${listen}${PRIVATE_STREAM_PATH}?access_token=${token}`);
    ws.on('message', (data) => frames.push(data.toString()));
    ws.on('error', () => undefined);
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
      setTimeout(resolve, 500);
    });
    expect(frames.some((f) => f.includes('"type":"ready"'))).toBe(false);
    ws.terminate();
  });

  it('a live seat drops on the next heartbeat after identity freezes the user', async () => {
    let status: AccountStatusSnapshot['status'] = 'active';
    const flipping: LiveCredentialPort = {
      async getSession() {
        return { id: SESSION, userId: USER, revoked: false };
      },
      async getApiKey() {
        return { id: KEY, userId: USER, revoked: false };
      },
      async getAccount() {
        return { userId: USER, status, ...(status === 'active' ? { lastVerifiedAt: '2026-08-25T00:00:00.000Z' } : {}) };
      },
    };
    const { port: listen } = await boot(flipping, 40);
    const token = await access();
    const frames: string[] = [];
    let closed = false;
    const ws = new WebSocket(`ws://127.0.0.1:${listen}${PRIVATE_STREAM_PATH}?access_token=${token}`);
    ws.on('message', (data) => frames.push(data.toString()));
    ws.on('error', () => undefined);
    ws.on('close', () => {
      closed = true;
    });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500);
      ws.once('message', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    expect(frames.some((f) => f.includes('"type":"ready"'))).toBe(true);
    status = 'frozen';
    await new Promise<void>((resolve) => {
      if (closed) {
        resolve();
        return;
      }
      ws.once('close', () => resolve());
      setTimeout(resolve, 2_000);
    });
    expect(closed).toBe(true);
    ws.terminate();
  });
});
