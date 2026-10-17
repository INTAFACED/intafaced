import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { TEST_AUTHORITY } from './test-support/authority.js';
import { PrivateOrderHub } from './private/hub.js';
import { createPrivateWebSocketGateway, PRIVATE_STREAM_PATH, type PrivateWebSocketGateway } from './private/gateway.js';
import { DropCopyHub } from './drop-copy/hub.js';
import { createDropCopyWebSocketGateway, DROP_COPY_STREAM_PATH, type DropCopyWebSocketGateway } from './drop-copy/gateway.js';
import { customerOriginsFromEnv } from './customer-origin.js';

const tokens: TokenConfig = {
  secret: 'test-access-secret-at-least-32-chars!!',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ALLOWED = 'https://app.example.com';

function upgradeStatus(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          ...headers,
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

describe('credentialed upgrades check the customer origin allowlist', () => {
  let server: Server;
  let port = 0;
  const closers: Array<{ close: (reason: string) => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((g) => g.close('done')));
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function boot(): Promise<void> {
    server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    port = addr.port;
    const log = { info: () => undefined, warn: () => undefined };
    const privateHub = new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 10, maxConnectionsPerUser: 10 });
    const dropHub = new DropCopyHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 10, recentLimit: 20 });
    const common = {
      server,
      heartbeatMs: 30_000,
      log,
      enabled: () => true,
      tokens,
      authority: TEST_AUTHORITY,
      customerOrigins: [ALLOWED],
    };
    closers.push(
      createPrivateWebSocketGateway({ ...common, hub: privateHub }) as PrivateWebSocketGateway,
      createDropCopyWebSocketGateway({ ...common, hub: dropHub }) as DropCopyWebSocketGateway,
    );
  }

  async function token(): Promise<string> {
    const issued = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:read'] }, tokens);
    return issued.token;
  }

  it('refuses a foreign Origin on the private and drop-copy upgrades and allows the list, the same host, and a missing Origin', async () => {
    await boot();
    const access = await token();
    const foreignPrivate = `${PRIVATE_STREAM_PATH}?access_token=${access}`;
    const foreignDrop = `${DROP_COPY_STREAM_PATH}?access_token=${access}`;
    expect(await upgradeStatus(port, foreignPrivate, { Origin: 'https://evil.example' })).toBe(403);
    expect(await upgradeStatus(port, foreignDrop, { Origin: 'https://evil.example' })).toBe(403);
    expect(await upgradeStatus(port, foreignPrivate, { Origin: ALLOWED })).toBe(101);
    expect(await upgradeStatus(port, foreignPrivate, { Origin: `http://127.0.0.1:${port}` })).toBe(101);
    expect(await upgradeStatus(port, foreignPrivate)).toBe(101);
  });

  it('reads the same EDGE_ALLOWED_ORIGINS list the edge uses, and rejects a wildcard', () => {
    expect(customerOriginsFromEnv({ APP_ENV: 'dev' })).toEqual(['http://localhost:3100', 'http://127.0.0.1:3100']);
    expect(customerOriginsFromEnv({ APP_ENV: 'prod' })).toEqual([]);
    expect(customerOriginsFromEnv({ APP_ENV: 'prod', EDGE_ALLOWED_ORIGINS: ALLOWED })).toEqual([ALLOWED]);
    expect(() => customerOriginsFromEnv({ EDGE_ALLOWED_ORIGINS: '*' })).toThrow(/wildcard/);
  });
});
