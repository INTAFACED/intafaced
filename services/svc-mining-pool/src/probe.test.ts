import { EventEmitter } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { ProbeRateLimit, dialPool, runProbe, type Dial } from './probe.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

function published(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MINING_POOL_HOST: 'pool.test',
    MINING_POOL_PORT: '3999',
    MINING_PROBE_LIMIT: '1',
    MINING_PROBE_WINDOW_MS: '60000',
    MINING_PROBE_TIMEOUT_MS: '1000',
    ...extra,
  };
}

function listen(handler?: (server: Server) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((socket) => {
    socket.end();
  });
  handler?.(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

describe('reachability probe', () => {
  it('dials only the configured host and reports a reachable or refused result', async () => {
    const open = await listen();
    try {
      const reachable = await dialPool('127.0.0.1', open.port, 1000);
      expect(reachable.kind).toBe('reachable');
      expect(reachable.roundTripMs).toBeGreaterThanOrEqual(0);
    } finally {
      await open.close();
    }
    const closed = await listen();
    const port = closed.port;
    await closed.close();
    const refused = await dialPool('127.0.0.1', port, 1000);
    expect(refused.kind).toBe('refused');
  });

  /** A socket that never connects: it reports the wait running out, or an error, exactly as told. */
  function fakeConnect(outcome: { timeout: true } | { error: string }) {
    return () => {
      const socket = new EventEmitter() as EventEmitter & { setTimeout: (ms: number) => void; destroy: () => void };
      socket.setTimeout = (ms) => {
        setTimeout(() => socket.emit('timeout'), 'timeout' in outcome ? ms : ms * 10);
        if ('error' in outcome) setTimeout(() => socket.emit('error', Object.assign(new Error(outcome.error), { code: outcome.error })), 5);
      };
      socket.destroy = () => undefined;
      return socket as unknown as Socket;
    };
  }

  it('a host that never answers is timed out after the whole wait, never a success', async () => {
    const outcome = await dialPool('pool.test', 9, 200, fakeConnect({ timeout: true }));
    expect(outcome.kind).toBe('timed_out');
    expect(outcome.roundTripMs).toBeGreaterThanOrEqual(195);
  });

  it('an error before the wait ends is not reached, never a time-out; the system connect time-out is a time-out', async () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND']) {
      const outcome = await dialPool('pool.test', 9, 5_000, fakeConnect({ error: code }));
      expect(outcome.kind, code).toBe('refused');
      expect(outcome.roundTripMs, code).toBeLessThan(5_000);
    }
    expect((await dialPool('pool.test', 9, 5_000, fakeConnect({ error: 'ETIMEDOUT' }))).kind).toBe('timed_out');
  });

  it('a blank limit, window, timeout or host refuses before the dial', async () => {
    const dial = vi.fn<Dial>(async () => {
      throw new Error('dialled');
    });
    const cases: Array<{ env: NodeJS.ProcessEnv; code: string }> = [
      { env: published({ MINING_PROBE_LIMIT: '  ' }), code: 'mining.probe_limit_unset' },
      { env: published({ MINING_PROBE_WINDOW_MS: '' }), code: 'mining.probe_limit_unset' },
      { env: published({ MINING_PROBE_TIMEOUT_MS: undefined }), code: 'mining.probe_timeout_unset' },
      { env: published({ MINING_PROBE_LIMIT: '100001' }), code: 'mining.probe_limit_unset' },
      { env: published({ MINING_POOL_HOST: '' }), code: 'mining.connection_unset' },
      { env: published({ MINING_POOL_PORT: '' }), code: 'mining.connection_unset' },
    ];
    for (const row of cases) {
      await expect(runProbe({ env: row.env, userId: ALICE, nowMs: 1_000, limiter: new ProbeRateLimit(), dial })).rejects.toMatchObject({
        code: row.code,
      });
    }
    expect(dial).not.toHaveBeenCalled();
  });

  it('two presses that cross the cap admit one, and a second account is separate', async () => {
    const calls: string[] = [];
    const dial: Dial = async (host, port) => {
      calls.push(`${host}:${port}`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { kind: 'reachable', roundTripMs: 4 };
    };
    const limiter = new ProbeRateLimit();
    const env = published();
    const first = runProbe({ env, userId: ALICE, nowMs: 5_000, limiter, dial });
    const second = runProbe({ env, userId: ALICE, nowMs: 5_000, limiter, dial });
    const [ok, blocked] = await Promise.allSettled([first, second]);
    const reached = [ok, blocked].find((row) => row.status === 'rejected');
    const allowed = [ok, blocked].find((row) => row.status === 'fulfilled');
    expect(allowed?.status).toBe('fulfilled');
    if (allowed?.status === 'fulfilled') {
      expect(allowed.value).toEqual({ result: 'reachable', roundTripMs: '4', viewpoint: 'pool_network' });
    }
    expect(reached?.status).toBe('rejected');
    if (reached?.status === 'rejected') expect(reached.reason).toMatchObject({ code: 'mining.probe_limit_reached' });
    expect(calls).toEqual(['pool.test:3999']);
    await expect(runProbe({ env, userId: BOB, nowMs: 5_000, limiter, dial })).resolves.toMatchObject({ result: 'reachable' });
    expect(calls).toEqual(['pool.test:3999', 'pool.test:3999']);
    await expect(runProbe({ env, userId: ALICE, nowMs: 65_000, limiter, dial })).resolves.toMatchObject({ result: 'reachable' });
  });

  it('a limit of zero admits nothing and a thrown dial is not reached, not a time-out or an error page', async () => {
    const dial = vi.fn<Dial>(async () => {
      throw new Error('down');
    });
    await expect(
      runProbe({ env: published({ MINING_PROBE_LIMIT: '0' }), userId: ALICE, nowMs: 1, limiter: new ProbeRateLimit(), dial }),
    ).rejects.toMatchObject({ code: 'mining.probe_limit_reached' });
    expect(dial).not.toHaveBeenCalled();
    const view = await runProbe({
      env: published({ MINING_PROBE_LIMIT: '2' }),
      userId: ALICE,
      nowMs: 1,
      limiter: new ProbeRateLimit(),
      dial,
    });
    expect(view.result).toBe('refused');
    expect(view.viewpoint).toBe('pool_network');
  });

  it('does not dial a host supplied beside the owner host', async () => {
    const seen: string[] = [];
    const dial: Dial = async (host) => {
      seen.push(host);
      return { kind: 'refused', roundTripMs: 1 };
    };
    await runProbe({
      env: published({ CALLER_HOST: 'evil.test', MINING_POOL_HOST: 'pool.test' }),
      userId: ALICE,
      nowMs: 1,
      limiter: new ProbeRateLimit(),
      dial,
    });
    expect(seen).toEqual(['pool.test']);
  });
});
