import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { issueAccessToken } from '@intafaced/auth';
import type { CurrentAuthorityResult } from '@intafaced/contracts';
import { PrivateOrderHub } from './hub.js';
import { createPrivateWebSocketGateway, PRIVATE_STREAM_PATH } from './gateway.js';
import { createDropCopyWebSocketGateway, DROP_COPY_STREAM_PATH } from '../drop-copy/gateway.js';
import { DropCopyHub } from '../drop-copy/hub.js';
import type { CurrentAuthorityPort } from './authority.js';
import { eligibleAuthority } from '../test-support/authority.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const tokens = {
  secret: 'authority-real-socket-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const log = { info: () => undefined, warn: () => undefined };

describe.each([PRIVATE_STREAM_PATH, DROP_COPY_STREAM_PATH])('mandatory live authority on %s', (path) => {
  let server: Server;
  let gateway: { connections: number; close(reason: string): Promise<void> };
  let base: string;
  afterEach(async () => {
    await gateway?.close('test done');
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  async function boot(authority: CurrentAuthorityPort | null) {
    server = createServer();
    const options = { server, heartbeatMs: 30000, log, enabled: () => true, tokens, authority };
    const limits = { highWaterBytes: 1000000, maxLagTicks: 5, maxConnections: 10, maxConnectionsPerUser: 10 };
    gateway =
      path === PRIVATE_STREAM_PATH
        ? createPrivateWebSocketGateway({ ...options, hub: new PrivateOrderHub(limits) })
        : createDropCopyWebSocketGateway({ ...options, hub: new DropCopyHub({ ...limits, recentLimit: 10 }) });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    base = `ws://127.0.0.1:${address.port}${path}`;
  }
  async function connect(apiKeyId?: string) {
    const { token } = await issueAccessToken(
      { userId: USER, sessionId: SESSION, scopes: ['trade:read'], ...(apiKeyId ? { apiKeyId } : {}) },
      tokens,
    );
    const socket = new WebSocket(`${base}?access_token=${token}`);
    const frames: string[] = [];
    socket.on('message', (data) => frames.push(String(data)));
    socket.on('error', () => undefined);
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return { socket, frames, closed };
  }

  it.each(['session', 'api_key', 'identity'] as const)('closes an idle %s seat without heartbeat or invalidation', async (kind) => {
    let revoked = false;
    await boot({
      async read(subject) {
        return revoked
          ? {
              subject,
              checkedAt: new Date().toISOString(),
              status: 'denied',
              code: kind === 'identity' ? 'auth.account_frozen' : 'auth.credential_revoked',
            }
          : eligibleAuthority(subject, 500);
      },
    });
    const client = await connect(kind === 'api_key' ? KEY : undefined);
    const at = performance.now();
    revoked = true;
    await client.closed;
    expect(performance.now() - at).toBeLessThan(5000);
    expect(gateway.connections).toBe(0);
  });

  it('closes independently during a partition and ignores a later eligible response', async () => {
    let reads = 0;
    let complete!: (value: CurrentAuthorityResult) => void;
    await boot({
      async read(subject) {
        if (++reads === 1) return eligibleAuthority(subject, 500);
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    });
    const client = await connect();
    const at = performance.now();
    await client.closed;
    expect(performance.now() - at).toBeLessThan(5000);
    const count = client.frames.length;
    complete(eligibleAuthority({ userId: USER, credential: { kind: 'session', sessionId: SESSION } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gateway.connections).toBe(0);
    expect(client.frames).toHaveLength(count);
    expect(reads).toBe(2);
  });

  it('closes when the authority service becomes unreachable', async () => {
    let unreachable = false;
    await boot({
      async read(subject) {
        if (unreachable) throw new Error('Identity partition');
        return eligibleAuthority(subject, 500);
      },
    });
    const client = await connect();
    unreachable = true;
    const at = performance.now();
    await client.closed;
    expect(performance.now() - at).toBeLessThan(5000);
    expect(gateway.connections).toBe(0);
  });

  it('refuses private upgrade with missing authority and sends no private frames', async () => {
    await boot(null);
    const { token } = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:read'] }, tokens);
    const socket = new WebSocket(`${base}?access_token=${token}`);
    const frames: string[] = [];
    socket.on('message', (data) => frames.push(String(data)));
    socket.on('error', () => undefined);
    const status = await new Promise<number>((resolve) =>
      socket.once('unexpected-response', (_req, res) => {
        res.resume();
        socket.terminate();
        resolve(res.statusCode ?? 0);
      }),
    );
    expect(status).toBe(503);
    expect(frames).toEqual([]);
  });
});
