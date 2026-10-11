import { TEST_AUTHORITY } from '../test-support/authority.js';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { PrivateOrderHub } from './hub.js';
import { CLOSE_UNAUTHORIZED, createPrivateWebSocketGateway, PRIVATE_STREAM_PATH, type PrivateWebSocketGateway } from './gateway.js';
import type { LiveCredentialPort, OwnershipSnapshot } from './live-credential.js';
import type { HubLogger } from '../depth/hub.js';
import { recoveredMintKeyRevokeDropsStream } from './recovery-mint-key-revoke-stream.js';

const SECRET = 'test-access-secret-at-least-32-chars!!';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEEP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const tokens: TokenConfig = {
  secret: SECRET,
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

function recoveredMintPort(): LiveCredentialPort & { revokeKey: () => void } {
  const state = { keyRevoked: false };
  return {
    revokeKey() {
      state.keyRevoked = true;
    },
    async getSession(sessionId: string): Promise<OwnershipSnapshot> {
      return { id: sessionId, userId: USER, revoked: false };
    },
    async getApiKey(): Promise<OwnershipSnapshot> {
      return { id: KEY, userId: USER, revoked: state.keyRevoked };
    },
  };
}

describe('private stream drops when a recovered-session minted API key is revoked', () => {
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

  async function access(apiKeyId?: string): Promise<string> {
    const issued = await issueAccessToken(
      { userId: USER, sessionId: KEEP, scopes: ['trade:write'], ...(apiKeyId ? { apiKeyId } : {}) },
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

  it('refuses the drop while the recovered-session key is still live', async () => {
    const live = recoveredMintPort();
    await expect(recoveredMintKeyRevokeDropsStream(live, { userId: USER, sessionId: KEEP, apiKeyId: KEY })).rejects.toMatchObject({
      code: 'auth.api_key_live',
    });
  });

  it('recovered session still upgrades; the minted key is refused after it is revoked', async () => {
    const live = recoveredMintPort();
    const { host, port } = await boot(live);
    const sessionToken = await access();
    const keyToken = await access(KEY);
    expect(await upgradeStatus(host, port, `${PRIVATE_STREAM_PATH}?access_token=${sessionToken}`)).toBe(101);
    expect(await upgradeStatus(host, port, `${PRIVATE_STREAM_PATH}?access_token=${keyToken}`)).toBe(101);
    live.revokeKey();
    await expect(recoveredMintKeyRevokeDropsStream(live, { userId: USER, sessionId: KEEP, apiKeyId: KEY })).resolves.toBeUndefined();
    expect(await upgradeStatus(host, port, `${PRIVATE_STREAM_PATH}?access_token=${sessionToken}`)).toBe(101);
    expect(await upgradeStatus(host, port, `${PRIVATE_STREAM_PATH}?access_token=${keyToken}`)).toBe(401);
  });

  it('the minted-key seat drops on heartbeat; recovered session stays', async () => {
    const live = recoveredMintPort();
    const { port: listen } = await boot(live, 40);
    const sessionToken = await access();
    const keyToken = await access(KEY);
    const keep = { closed: null as { code: number } | null, ready: false };
    const keySeat = { closed: null as { code: number } | null, ready: false };
    const keepWs = new WebSocket(`ws://127.0.0.1:${listen}${PRIVATE_STREAM_PATH}?access_token=${sessionToken}`);
    const keyWs = new WebSocket(`ws://127.0.0.1:${listen}${PRIVATE_STREAM_PATH}?access_token=${keyToken}`);
    keepWs.on('message', (data) => {
      if (data.toString().includes('"type":"ready"')) keep.ready = true;
    });
    keyWs.on('message', (data) => {
      if (data.toString().includes('"type":"ready"')) keySeat.ready = true;
    });
    keepWs.on('error', () => undefined);
    keyWs.on('error', () => undefined);
    keepWs.on('close', (code) => {
      keep.closed = { code };
    });
    keyWs.on('close', (code) => {
      keySeat.closed = { code };
    });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 800);
      const check = () => {
        if (keep.ready && keySeat.ready) {
          clearTimeout(timer);
          resolve();
        }
      };
      keepWs.once('message', check);
      keyWs.once('message', check);
    });
    expect(keep.ready).toBe(true);
    expect(keySeat.ready).toBe(true);
    live.revokeKey();
    await recoveredMintKeyRevokeDropsStream(live, { userId: USER, sessionId: KEEP, apiKeyId: KEY });
    await new Promise<void>((resolve) => {
      if (keySeat.closed) {
        resolve();
        return;
      }
      keyWs.once('close', () => resolve());
      setTimeout(resolve, 2_000);
    });
    expect(keySeat.closed?.code).toBe(CLOSE_UNAUTHORIZED);
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(keep.closed).toBeNull();
    keepWs.terminate();
    keyWs.terminate();
  });
});
