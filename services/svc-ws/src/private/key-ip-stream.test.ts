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
const LISTED = '203.0.113.10';
const FOREIGN = '198.51.100.7';

const tokens: TokenConfig = {
  secret: SECRET,
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

function keyPort(allowlist: readonly string[]): LiveCredentialPort {
  const snap: OwnershipSnapshot = { id: KEY, userId: USER, revoked: false, ipAllowlist: allowlist };
  return {
    async getSession() {
      return { id: SESSION, userId: USER, revoked: false };
    },
    async getApiKey() {
      return snap;
    },
  };
}

describe('private stream drops when the caller IP is not on the key', () => {
  let server: Server;
  let gateway: PrivateWebSocketGateway;

  afterEach(async () => {
    await gateway?.close('test done');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function boot(liveCredential: LiveCredentialPort): Promise<{ host: string; port: number }> {
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

  function upgradeStatus(host: string, port: number, path: string, forwarded?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      };
      if (forwarded !== undefined) headers['x-forwarded-for'] = forwarded;
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

  it('listed IP upgrades; foreign IP and missing IP refuse with 401', async () => {
    const { host, port } = await boot(keyPort([LISTED]));
    const token = await access();
    const path = `${PRIVATE_STREAM_PATH}?access_token=${token}`;
    expect(await upgradeStatus(host, port, path, LISTED)).toBe(101);
    expect(await upgradeStatus(host, port, path, FOREIGN)).toBe(401);
    expect(await upgradeStatus(host, port, path)).toBe(401);
  });

  it('empty allowlist stays open without a forwarded IP', async () => {
    const { host, port } = await boot(keyPort([]));
    const token = await access();
    expect(await upgradeStatus(host, port, `${PRIVATE_STREAM_PATH}?access_token=${token}`)).toBe(101);
  });

  it('session token (no kid) is not IP-gated', async () => {
    const { host, port } = await boot(keyPort([LISTED]));
    const issued = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:write'] }, tokens);
    expect(await upgradeStatus(host, port, `${PRIVATE_STREAM_PATH}?access_token=${issued.token}`, FOREIGN)).toBe(101);
  });

  it('foreign IP never receives a ready frame', async () => {
    const { port } = await boot(keyPort([LISTED]));
    const token = await access();
    const frames: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}${PRIVATE_STREAM_PATH}?access_token=${token}`, {
      headers: { 'x-forwarded-for': FOREIGN },
    });
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
