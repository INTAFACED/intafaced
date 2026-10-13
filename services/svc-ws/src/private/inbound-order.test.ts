import { TEST_AUTHORITY } from '../test-support/authority.js';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { PrivateOrderHub } from './hub.js';
import { createPrivateWebSocketGateway, PRIVATE_STREAM_PATH, type PrivateWebSocketGateway } from './gateway.js';
import { CodController } from './cod.js';
import type { LiveCredentialPort } from './live-credential.js';

const SECRET = 'test-access-secret-at-least-32-chars!!';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const tokens: TokenConfig = { secret: SECRET, issuer: 'intafaced', audience: 'intafaced.api', accessTtlSeconds: 900 };

describe('L1073 private stream inbound order', () => {
  let server: Server;
  let gateway: PrivateWebSocketGateway;

  afterEach(async () => {
    vi.restoreAllMocks();
    await gateway?.close('test done');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('handles inbound COD text in arrival order even when the first live check settles last', async () => {
    // Armed just before the frames go out: the first inbound live check settles
    // after the second one, which reorders handleText without a per-socket chain.
    let slowNext = false;
    const live: LiveCredentialPort = {
      async getSession() {
        if (slowNext) {
          slowNext = false;
          await new Promise((r) => setTimeout(r, 200));
        }
        return { id: SESSION, userId: USER, revoked: false };
      },
      async getApiKey() {
        return null;
      },
    };
    const seen: string[] = [];
    vi.spyOn(CodController.prototype, 'handleText').mockImplementation(function (_ws: unknown, text: string) {
      seen.push(text);
    } as never);

    const hub = new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 10, maxConnectionsPerUser: 10 });
    server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    gateway = createPrivateWebSocketGateway({
      server,
      hub,
      heartbeatMs: 30_000,
      log: { info: () => undefined, warn: () => undefined },
      enabled: () => true,
      tokens,
      authority: TEST_AUTHORITY,
      liveCredential: live,
      codRange: { minTtlMs: 50, maxTtlMs: 60_000 },
    });
    const access = (await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:write'] }, tokens)).token;
    const socket = new WebSocket(`ws://127.0.0.1:${addr.port}${PRIVATE_STREAM_PATH}?access_token=${access}`);
    await new Promise<void>((resolve, reject) => {
      socket.once('message', () => resolve());
      socket.once('error', reject);
    });
    slowNext = true;
    socket.send('{"type":"cod.arm","commandId":"first"}');
    socket.send('{"type":"cod.disarm","commandId":"second"}');
    await vi.waitFor(() => expect(seen.length).toBe(2), { timeout: 2_000 });
    expect(seen.map((t) => (JSON.parse(t) as { commandId: string }).commandId)).toEqual(['first', 'second']);
    socket.close();
  });

  it('does not hand a queued frame to handleText after an inbound live-check failure closes the socket (Break F1)', async () => {
    // First inbound live check throws once (transient) -> cod.drop + graceful
    // closeUnauthorized. The second frame is already queued on the chain; 'close'
    // has not fired yet, so it must not re-verify and reach handleText on a
    // CLOSING socket (that would re-arm a COD lease after the drop).
    let failNext = false;
    const live: LiveCredentialPort = {
      async getSession() {
        if (failNext) {
          failNext = false;
          throw new Error('transient');
        }
        return { id: SESSION, userId: USER, revoked: false };
      },
      async getApiKey() {
        return null;
      },
    };
    const seen: Array<{ cmd: string; state: number }> = [];
    vi.spyOn(CodController.prototype, 'handleText').mockImplementation(function (ws: WebSocket, text: string) {
      seen.push({ cmd: (JSON.parse(text) as { commandId: string }).commandId, state: ws.readyState });
    } as never);

    const hub = new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 10, maxConnectionsPerUser: 10 });
    server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    gateway = createPrivateWebSocketGateway({
      server,
      hub,
      heartbeatMs: 30_000,
      log: { info: () => undefined, warn: () => undefined },
      enabled: () => true,
      tokens,
      authority: TEST_AUTHORITY,
      liveCredential: live,
      codRange: { minTtlMs: 50, maxTtlMs: 60_000 },
    });
    const access = (await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:write'] }, tokens)).token;
    const socket = new WebSocket(`ws://127.0.0.1:${addr.port}${PRIVATE_STREAM_PATH}?access_token=${access}`);
    await new Promise<void>((resolve, reject) => {
      socket.once('message', () => resolve());
      socket.once('error', reject);
    });
    const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
    failNext = true;
    socket.send('{"type":"cod.arm","commandId":"first"}');
    socket.send('{"type":"cod.arm","commandId":"second"}');
    await closed;
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toEqual([]);
    socket.terminate();
  });
});
