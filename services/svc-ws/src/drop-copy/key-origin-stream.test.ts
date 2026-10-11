import { TEST_AUTHORITY } from '../test-support/authority.js';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { DropCopyHub } from './hub.js';
import { createDropCopyWebSocketGateway, DROP_COPY_STREAM_PATH, type DropCopyWebSocketGateway } from './gateway.js';
import type { LiveCredentialPort, OwnershipSnapshot } from '../private/live-credential.js';
import type { HubLogger } from '../depth/hub.js';

const SECRET = 'test-access-secret-at-least-32-chars!!';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LISTED = 'app.example.com';
const LISTED_ORIGIN = 'https://app.example.com';
const FOREIGN_ORIGIN = 'https://evil.example';

const tokens: TokenConfig = {
  secret: SECRET,
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

function keyPort(allowlist: readonly string[]): LiveCredentialPort {
  const snap: OwnershipSnapshot = { id: KEY, userId: USER, revoked: false, originAllowlist: allowlist };
  return {
    async getSession() {
      return { id: SESSION, userId: USER, revoked: false };
    },
    async getApiKey() {
      return snap;
    },
  };
}

describe('drop-copy stream drops when the Origin is not on the key', () => {
  let server: Server;
  let gateway: DropCopyWebSocketGateway;

  afterEach(async () => {
    await gateway?.close('test done');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function boot(liveCredential: LiveCredentialPort): Promise<{ host: string; port: number }> {
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

  function upgradeStatus(host: string, port: number, path: string, origin?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      };
      if (origin !== undefined) headers.Origin = origin;
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

  it('listed Origin upgrades; foreign Origin and missing Origin refuse with 401', async () => {
    const { host, port } = await boot(keyPort([LISTED]));
    const token = await access();
    const path = `${DROP_COPY_STREAM_PATH}?access_token=${token}`;
    expect(await upgradeStatus(host, port, path, LISTED_ORIGIN)).toBe(101);
    expect(await upgradeStatus(host, port, path, FOREIGN_ORIGIN)).toBe(401);
    expect(await upgradeStatus(host, port, path)).toBe(401);
  });

  it('empty allowlist stays open without an Origin header', async () => {
    const { host, port } = await boot(keyPort([]));
    const token = await access();
    expect(await upgradeStatus(host, port, `${DROP_COPY_STREAM_PATH}?access_token=${token}`)).toBe(101);
  });

  it('session token (no kid) is not origin-gated', async () => {
    const { host, port } = await boot(keyPort([LISTED]));
    const issued = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:write'] }, tokens);
    expect(await upgradeStatus(host, port, `${DROP_COPY_STREAM_PATH}?access_token=${issued.token}`, FOREIGN_ORIGIN)).toBe(101);
  });

  it('foreign Origin never receives a ready frame', async () => {
    const { port } = await boot(keyPort([LISTED]));
    const token = await access();
    const frames: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}${DROP_COPY_STREAM_PATH}?access_token=${token}`, {
      headers: { Origin: FOREIGN_ORIGIN },
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
