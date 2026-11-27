import { TEST_AUTHORITY } from '../test-support/authority.js';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { DropCopyHub } from './hub.js';
import { createDropCopyWebSocketGateway, DROP_COPY_STREAM_PATH, type DropCopyWebSocketGateway } from './gateway.js';
import type { LiveCredentialPort, OwnershipSnapshot } from '../private/live-credential.js';
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

describe('drop-copy stream checks the key IP allowlist against the caller (#11038)', () => {
  let server: Server;
  let gateway: DropCopyWebSocketGateway;

  afterEach(async () => {
    await gateway?.close('test done');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function boot(liveCredential: LiveCredentialPort, trustedProxies?: readonly string[]): Promise<{ host: string; port: number }> {
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
      ...(trustedProxies ? { trustedProxies } : {}),
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

  it('with no trusted front, a client-supplied listed address does not stand in for the TCP peer', async () => {
    const { host, port } = await boot(keyPort([LISTED]));
    const token = await access();
    expect(await upgradeStatus(host, port, `${DROP_COPY_STREAM_PATH}?access_token=${token}`, LISTED)).toBe(401);
  });

  it('behind a trusted loopback front, the forwarded address is the caller the key is checked against', async () => {
    const { host, port } = await boot(keyPort([LISTED]), ['127.0.0.1']);
    const token = await access();
    const path = `${DROP_COPY_STREAM_PATH}?access_token=${token}`;
    expect(await upgradeStatus(host, port, path, LISTED)).toBe(101);
    expect(await upgradeStatus(host, port, path, FOREIGN)).toBe(401);
    expect(await upgradeStatus(host, port, path)).toBe(401);
  });

  it('a forged forwarded address from a peer that is not the trusted front is ignored', async () => {
    const { host, port } = await boot(keyPort([LISTED]), ['10.0.0.1']);
    const token = await access();
    expect(await upgradeStatus(host, port, `${DROP_COPY_STREAM_PATH}?access_token=${token}`, LISTED)).toBe(401);
  });
});
