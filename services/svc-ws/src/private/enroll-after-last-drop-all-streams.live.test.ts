import { TEST_AUTHORITY } from '../test-support/authority.js';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { PrivateOrderHub } from './hub.js';
import { createPrivateWebSocketGateway, PRIVATE_STREAM_PATH, type PrivateWebSocketGateway } from './gateway.js';
import type { LiveCredentialPort, OwnershipSnapshot } from './live-credential.js';
import type { HubLogger } from '../depth/hub.js';

const SECRET = 'test-access-secret-at-least-32-chars!!';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const VERIFIED = '2026-08-25T00:00:00.000Z';
const OWNERSHIP = 'ws-test-identity-ownership-secret-32';

const tokens: TokenConfig = {
  secret: SECRET,
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

function passkeyPort(account: Record<string, unknown> | (() => Record<string, unknown>), http = 200): LiveCredentialPort {
  const session: OwnershipSnapshot = { id: SESSION, userId: USER, revoked: false };
  const key: OwnershipSnapshot = { id: KEY, userId: USER, revoked: false };
  return {
    async getSession() {
      return session;
    },
    async getApiKey() {
      return key;
    },
    sessionPasskey: {
      identityUrl: 'http://identity.test',
      identityOwnershipSecret: OWNERSHIP,
      fetch: async () => {
        const body = typeof account === 'function' ? account() : account;
        return new Response(JSON.stringify(body), {
          status: http,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  };
}

describe('every private stream drops unless the newly enrolled passkey verifies following last-unenroll', () => {
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

  async function access(): Promise<string> {
    const issued = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:write'] }, tokens);
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

  it('newly enrolled verified cred upgrades every private stream on the existing session', async () => {
    const { host, port } = await boot(
      passkeyPort({
        userId: USER,
        webauthnCreds: [{ credentialId: 'cred-3', lastVerifiedAt: VERIFIED }],
      }),
    );
    const token = await access();
    expect(await upgradeStatus(host, port, `${PRIVATE_STREAM_PATH}?access_token=${token}`)).toBe(101);
    expect(await upgradeStatus(host, port, `${PRIVATE_STREAM_PATH}?access_token=${token}`)).toBe(101);
  });

  it('empty after last unenroll refuses every upgrade', async () => {
    const { host, port } = await boot(passkeyPort({ userId: USER, webauthnCreds: [] }));
    const token = await access();
    expect(await upgradeStatus(host, port, `${PRIVATE_STREAM_PATH}?access_token=${token}`)).not.toBe(101);
    expect(await upgradeStatus(host, port, `${PRIVATE_STREAM_PATH}?access_token=${token}`)).not.toBe(101);
  });

  it('every private stream stays open, then all drop on heartbeat if none remain', async () => {
    let account: Record<string, unknown> = {
      userId: USER,
      webauthnCreds: [{ credentialId: 'cred-3', lastVerifiedAt: VERIFIED }],
    };
    const { port: listen } = await boot(
      passkeyPort(() => account),
      40,
    );
    const token = await access();
    const closed = [false, false];
    const ready = [false, false];
    const sockets = [0, 1].map((i) => {
      const ws = new WebSocket(`ws://127.0.0.1:${listen}${PRIVATE_STREAM_PATH}?access_token=${token}`);
      ws.on('message', (data) => {
        if (data.toString().includes('"type":"ready"')) ready[i] = true;
      });
      ws.on('error', () => undefined);
      ws.on('close', () => {
        closed[i] = true;
      });
      return ws;
    });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 800);
      const check = () => {
        if (ready[0] && ready[1]) {
          clearTimeout(timer);
          resolve();
        }
      };
      sockets[0]?.once('message', check);
      sockets[1]?.once('message', check);
    });
    expect(ready).toEqual([true, true]);
    expect(closed).toEqual([false, false]);

    account = { userId: USER, webauthnCreds: [] };
    await new Promise<void>((resolve) => {
      if (closed[0] && closed[1]) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 2_000);
      const check = () => {
        if (closed[0] && closed[1]) {
          clearTimeout(timer);
          resolve();
        }
      };
      sockets[0]?.once('close', check);
      sockets[1]?.once('close', check);
    });
    expect(closed).toEqual([true, true]);
    for (const ws of sockets) ws.terminate();
  });
});
