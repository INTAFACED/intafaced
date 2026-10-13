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

const tokens: TokenConfig = {
  secret: SECRET,
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

function keyPort(allowlist: readonly string[] | undefined): LiveCredentialPort {
  const snap: OwnershipSnapshot = {
    id: KEY,
    userId: USER,
    revoked: false,
    ...(allowlist === undefined ? {} : { productAllowlist: allowlist }),
  };
  return {
    async getSession() {
      return { id: SESSION, userId: USER, revoked: false };
    },
    async getApiKey() {
      return snap;
    },
  };
}

describe('private stream drops when the product is not on the key', () => {
  let server: Server;
  let gateway: PrivateWebSocketGateway;

  afterEach(async () => {
    await gateway?.close('test done');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function boot(liveCredential: LiveCredentialPort): Promise<{ host: string; port: number }> {
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
      heartbeatMs: 30_000,
      log,
      enabled: () => true,
      tokens,
      liveCredential,
    });
    return { host: '127.0.0.1', port: addr.port };
  }

  async function access(): Promise<string> {
    const issued = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:write'], apiKeyId: KEY }, tokens);
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

  it('trade-listed key upgrades; pay-only refuses with 401', async () => {
    const { host, port } = await boot(keyPort(['trade']));
    const token = await access();
    const path = `${PRIVATE_STREAM_PATH}?access_token=${token}`;
    expect(await upgradeStatus(host, port, path)).toBe(101);
  });

  it('pay-only and unknown-product lists refuse with 401', async () => {
    const token = await access();
    const path = `${PRIVATE_STREAM_PATH}?access_token=${token}`;
    const pay = await boot(keyPort(['pay']));
    expect(await upgradeStatus(pay.host, pay.port, path)).toBe(401);
  });

  it('unknown product (spot) refuses with 401', async () => {
    const { host, port } = await boot(keyPort(['spot']));
    const token = await access();
    expect(await upgradeStatus(host, port, `${PRIVATE_STREAM_PATH}?access_token=${token}`)).toBe(401);
  });

  it('empty allowlist stays open — does not invent trade', async () => {
    const { host, port } = await boot(keyPort([]));
    const token = await access();
    expect(await upgradeStatus(host, port, `${PRIVATE_STREAM_PATH}?access_token=${token}`)).toBe(101);
  });

  it('omitted allowlist stays open — does not invent trade', async () => {
    const { host, port } = await boot(keyPort(undefined));
    const token = await access();
    expect(await upgradeStatus(host, port, `${PRIVATE_STREAM_PATH}?access_token=${token}`)).toBe(101);
  });

  it('session token (no kid) is not product-gated', async () => {
    const { host, port } = await boot(keyPort(['pay']));
    const issued = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:write'] }, tokens);
    expect(await upgradeStatus(host, port, `${PRIVATE_STREAM_PATH}?access_token=${issued.token}`)).toBe(101);
  });

  it('pay-only key never receives a ready frame', async () => {
    const { port } = await boot(keyPort(['pay']));
    const token = await access();
    const frames: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}${PRIVATE_STREAM_PATH}?access_token=${token}`);
    ws.on('message', (data) => frames.push(data.toString()));
    ws.on('error', () => undefined);
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
      setTimeout(resolve, 500);
    });
    expect(frames.some((f) => f.includes('"type":"ready"'))).toBe(false);
    ws.terminate();
  });
});
