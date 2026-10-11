import { TEST_AUTHORITY } from '../test-support/authority.js';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { PRIVATE_STREAM_PATH } from '../private/gateway.js';
import type { LiveCredentialPort, OwnershipSnapshot } from '../private/live-credential.js';
import type { HubLogger } from '../depth/hub.js';
import { DropCopyHub } from './hub.js';
import { CLOSE_UNAUTHORIZED, createDropCopyWebSocketGateway, DROP_COPY_STREAM_PATH, type DropCopyWebSocketGateway } from './gateway.js';
import { recoveryCodeDropsOtherDropCopyStreams } from './recovery-drop-other-streams.js';

const SECRET = 'test-access-secret-at-least-32-chars!!';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEEP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CODE = 'A1B2C-D3E4F';

const tokens: TokenConfig = {
  secret: SECRET,
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

function twoSeatPort(): LiveCredentialPort & { dropOthers: () => void } {
  const revoked = new Set<string>();
  return {
    dropOthers() {
      revoked.add(OTHER);
    },
    async getSession(sessionId: string): Promise<OwnershipSnapshot> {
      return { id: sessionId, userId: USER, revoked: revoked.has(sessionId) };
    },
    async getApiKey(): Promise<OwnershipSnapshot> {
      return { id: KEY, userId: USER, revoked: false };
    },
  };
}

describe('other drop-copy streams drop after a recovery code; recovered session stays', () => {
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

  async function access(sessionId: string): Promise<string> {
    const issued = await issueAccessToken({ userId: USER, sessionId, scopes: ['trade:read'] }, tokens);
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

  it('spent or missing recovery code refuses before any drop-copy seat is dropped', () => {
    expect(() => recoveryCodeDropsOtherDropCopyStreams({ code: '', recoveryCodeHashes: ['h'] })).toThrow(/missing/);
    expect(() => recoveryCodeDropsOtherDropCopyStreams({ code: CODE, recoveryCodeHashes: [] })).toThrow(/spent/);
  });

  it('recovered session still upgrades drop-copy; other live session is refused after the code revokes it', async () => {
    expect(DROP_COPY_STREAM_PATH).not.toBe(PRIVATE_STREAM_PATH);
    const live = twoSeatPort();
    const { host, port } = await boot(live);
    const keepToken = await access(KEEP);
    const otherToken = await access(OTHER);
    expect(await upgradeStatus(host, port, `${DROP_COPY_STREAM_PATH}?access_token=${keepToken}`)).toBe(101);
    expect(await upgradeStatus(host, port, `${DROP_COPY_STREAM_PATH}?access_token=${otherToken}`)).toBe(101);
    recoveryCodeDropsOtherDropCopyStreams({ code: CODE, recoveryCodeHashes: ['h'] });
    live.dropOthers();
    expect(await upgradeStatus(host, port, `${DROP_COPY_STREAM_PATH}?access_token=${keepToken}`)).toBe(101);
    expect(await upgradeStatus(host, port, `${DROP_COPY_STREAM_PATH}?access_token=${otherToken}`)).toBe(401);
  });

  it('the other session drop-copy seat drops on heartbeat; recovered session stays', async () => {
    const live = twoSeatPort();
    const { port: listen } = await boot(live, 40);
    const keepToken = await access(KEEP);
    const otherToken = await access(OTHER);
    const keep = { closed: null as { code: number } | null, opened: false };
    const other = { closed: null as { code: number } | null, opened: false };
    const keepWs = new WebSocket(`ws://127.0.0.1:${listen}${DROP_COPY_STREAM_PATH}?access_token=${keepToken}`);
    const otherWs = new WebSocket(`ws://127.0.0.1:${listen}${DROP_COPY_STREAM_PATH}?access_token=${otherToken}`);
    keepWs.on('open', () => {
      keep.opened = true;
    });
    otherWs.on('open', () => {
      other.opened = true;
    });
    keepWs.on('error', () => undefined);
    otherWs.on('error', () => undefined);
    keepWs.on('close', (code) => {
      keep.closed = { code };
    });
    otherWs.on('close', (code) => {
      other.closed = { code };
    });
    await new Promise<void>((resolve) => {
      const tick = setInterval(() => {
        if ((keep.opened || keep.closed) && (other.opened || other.closed)) {
          clearTimeout(timer);
          clearInterval(tick);
          resolve();
        }
      }, 10);
      const timer = setTimeout(() => {
        clearInterval(tick);
        resolve();
      }, 800);
    });
    expect(keep.opened).toBe(true);
    expect(other.opened).toBe(true);
    recoveryCodeDropsOtherDropCopyStreams({ code: CODE, recoveryCodeHashes: ['h'] });
    live.dropOthers();
    await new Promise<void>((resolve) => {
      if (other.closed) {
        resolve();
        return;
      }
      otherWs.once('close', () => resolve());
      setTimeout(resolve, 2_000);
    });
    expect(other.closed?.code).toBe(CLOSE_UNAUTHORIZED);
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(keep.closed).toBeNull();
    keepWs.terminate();
    otherWs.terminate();
  });
});
