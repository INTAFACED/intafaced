import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { PrivateOrderHub } from './hub.js';
import { CLOSE_UNAUTHORIZED, createPrivateWebSocketGateway, PRIVATE_STREAM_PATH, type PrivateWebSocketGateway } from './gateway.js';
import type { LiveCredentialPort, OwnershipSnapshot } from './live-credential.js';
import type { HubLogger } from '../depth/hub.js';
import { recoveryCodeDropsOtherStreams } from './recovery-drop-other-streams.js';

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

describe('other private streams drop after a recovery code; recovered session stays', () => {
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

  async function access(sessionId: string): Promise<string> {
    const issued = await issueAccessToken({ userId: USER, sessionId, scopes: ['trade:write'] }, tokens);
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

  it('spent or missing recovery code refuses before any seat is dropped', () => {
    expect(() => recoveryCodeDropsOtherStreams({ code: '', recoveryCodeHashes: ['h'] })).toThrow(/missing/);
    expect(() => recoveryCodeDropsOtherStreams({ code: CODE, recoveryCodeHashes: [] })).toThrow(/spent/);
  });

  it('recovered session still upgrades; other live session is refused after the code revokes it', async () => {
    const live = twoSeatPort();
    const { host, port } = await boot(live);
    const keepToken = await access(KEEP);
    const otherToken = await access(OTHER);
    expect(await upgradeStatus(host, port, `${PRIVATE_STREAM_PATH}?access_token=${keepToken}`)).toBe(101);
    expect(await upgradeStatus(host, port, `${PRIVATE_STREAM_PATH}?access_token=${otherToken}`)).toBe(101);
    recoveryCodeDropsOtherStreams({ code: CODE, recoveryCodeHashes: ['h'] });
    live.dropOthers();
    expect(await upgradeStatus(host, port, `${PRIVATE_STREAM_PATH}?access_token=${keepToken}`)).toBe(101);
    expect(await upgradeStatus(host, port, `${PRIVATE_STREAM_PATH}?access_token=${otherToken}`)).toBe(401);
  });

  it('the other session seat drops on heartbeat; recovered session stays', async () => {
    const live = twoSeatPort();
    const { port: listen } = await boot(live, 40);
    const keepToken = await access(KEEP);
    const otherToken = await access(OTHER);
    const keep = { closed: null as { code: number } | null, ready: false };
    const other = { closed: null as { code: number } | null, ready: false };
    const keepWs = new WebSocket(`ws://127.0.0.1:${listen}${PRIVATE_STREAM_PATH}?access_token=${keepToken}`);
    const otherWs = new WebSocket(`ws://127.0.0.1:${listen}${PRIVATE_STREAM_PATH}?access_token=${otherToken}`);
    keepWs.on('message', (data) => {
      if (data.toString().includes('"type":"ready"')) keep.ready = true;
    });
    otherWs.on('message', (data) => {
      if (data.toString().includes('"type":"ready"')) other.ready = true;
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
      const timer = setTimeout(resolve, 800);
      const check = () => {
        if (keep.ready && other.ready) {
          clearTimeout(timer);
          resolve();
        }
      };
      keepWs.once('message', check);
      otherWs.once('message', check);
    });
    expect(keep.ready).toBe(true);
    expect(other.ready).toBe(true);
    recoveryCodeDropsOtherStreams({ code: CODE, recoveryCodeHashes: ['h'] });
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
