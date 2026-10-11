import { TEST_AUTHORITY } from '../test-support/authority.js';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { PRIVATE_STREAM_PATH } from '../private/gateway.js';
import type { LiveCredentialPort, OwnershipSnapshot } from '../private/live-credential.js';
import { DropCopyHub } from './hub.js';
import { createDropCopyWebSocketGateway, DROP_COPY_STREAM_PATH, type DropCopyWebSocketGateway } from './gateway.js';
import { recoveryCodeOpensRecoveredDropCopyStream } from './recovery-open-recovered-stream.js';

const SECRET = 'test-access-secret-at-least-32-chars!!';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEEP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CODE = 'A1B2C-D3E4F';

const tokens: TokenConfig = {
  secret: SECRET,
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

function recoveredPort(): LiveCredentialPort {
  const session: OwnershipSnapshot = { id: KEEP, userId: USER, revoked: false };
  const key: OwnershipSnapshot = { id: KEY, userId: USER, revoked: false };
  return {
    async getSession() {
      return session;
    },
    async getApiKey() {
      return key;
    },
  };
}

describe('drop-copy stream opens on the recovered session after a recovery redeem', () => {
  let server: Server;
  let gateway: DropCopyWebSocketGateway;

  afterEach(async () => {
    await gateway?.close('test done');
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function boot(liveCredential: LiveCredentialPort): Promise<{ host: string; port: number }> {
    const hub = new DropCopyHub({
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 10,
      maxConnectionsPerUser: 10,
      recentLimit: 10,
    });
    hub.announceBus(true);
    server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const log = { info: () => undefined, warn: () => undefined };
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
    const issued = await issueAccessToken({ userId: USER, sessionId: KEEP, scopes: ['trade:read'] }, tokens);
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

  it('spent or missing recovery code refuses before the recovered drop-copy stream opens', () => {
    expect(() => recoveryCodeOpensRecoveredDropCopyStream({ code: '', recoveryCodeHashes: ['h'] })).toThrow(/missing/);
    expect(() => recoveryCodeOpensRecoveredDropCopyStream({ code: CODE, recoveryCodeHashes: [] })).toThrow(/spent/);
  });

  it('recovered session upgrades drop-copy after a remaining recovery code; not the private trading path', async () => {
    expect(DROP_COPY_STREAM_PATH).not.toBe(PRIVATE_STREAM_PATH);
    recoveryCodeOpensRecoveredDropCopyStream({ code: CODE, recoveryCodeHashes: ['h'] });
    const { host, port } = await boot(recoveredPort());
    const token = await access();
    expect(await upgradeStatus(host, port, `${DROP_COPY_STREAM_PATH}?access_token=${token}`)).toBe(101);
  });
});
