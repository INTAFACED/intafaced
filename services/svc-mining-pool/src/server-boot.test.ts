/**
 * svc-mining-pool's own entrypoint, booted: `server.ts` imported with its env (a database client that never connects,
 * a ledger client that records) and the request handler it builds driven over HTTP. What this proves is what the
 * started process serves and runs (its health answer, its one payout job, no post at boot), not what its source says.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EDGE_PRINCIPAL_HEADER, EDGE_SIGNATURE_HEADER, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SANCTIONS_REGIONS_ENV, SANCTIONS_SOURCE_ENV, SCREENING_REVIEWED_EMPTY } from '@intafaced/config';
import { miningHealthHonesty } from './health-honesty.js';
import { MINING_EPOCH_PAYOUT_JOB } from './epoch-jobs.js';

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

const booted = vi.hoisted(() => ({
  handlers: [] as Handler[],
  jobs: [] as Array<{ stop(): void }>,
  intervals: [] as number[],
  posts: [] as unknown[],
}));

vi.mock('postgres', () => {
  // A client that is constructed but never asked: boot opens no connection.
  const sql = new Proxy(() => undefined, { get: () => () => undefined, apply: () => Promise.resolve([]) });
  return { default: () => sql };
});
vi.mock('./ledger-client.js', () => ({
  createLedgerClient: () => ({
    post: async (request: unknown) => {
      booted.posts.push(request);
      throw new Error('TEST: no ledger in this boot');
    },
    getTxByKey: async () => null,
  }),
}));
vi.mock('./http.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./http.js')>();
  return {
    ...real,
    createMiningRequestHandler: (deps: Parameters<typeof real.createMiningRequestHandler>[0]) => {
      const handler = real.createMiningRequestHandler(deps);
      booted.handlers.push(handler);
      return handler;
    },
  };
});
vi.mock('./epoch-jobs.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./epoch-jobs.js')>();
  return {
    ...real,
    startMiningJobs: (deps: Parameters<typeof real.startMiningJobs>[0]) => {
      // The job is scheduled on a clock this test holds, so it never ticks by itself.
      const handle = real.startMiningJobs({
        ...deps,
        setIntervalFn: ((_fn: () => void, ms: number) => {
          booted.intervals.push(ms);
          return setTimeout(() => undefined, 0);
        }) as typeof setInterval,
        clearIntervalFn: (() => undefined) as typeof clearInterval,
      });
      booted.jobs.push(handle);
      return handle;
    },
  };
});

const servers: Server[] = [];

async function boot(env: Record<string, string | undefined>) {
  vi.resetModules();
  booted.handlers.length = 0;
  booted.intervals.length = 0;
  booted.posts.length = 0;
  for (const [key, value] of Object.entries({
    DATABASE_URL: undefined,
    LEDGER_URL: undefined,
    INTERNAL_SERVICE_SECRET: undefined,
    MINING_PAYOUT_INTERVAL_MS: undefined,
    EDGE_PRINCIPAL_SECRET: 's'.repeat(32),
    ...env,
  }))
    vi.stubEnv(key, value);
  await import('./server.js');
  const handler = booted.handlers.at(-1);
  if (!handler) throw new Error('server.ts built no request handler');
  const server = createServer((request, response) => void handler(request, response));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, { headers });
    return { status: res.status, text: await res.text() };
  };
}

/** Edge headers for a miner the edge signed with `secret`. */
function signedAs(secret: string): Record<string, string> {
  const raw = encodePrincipal({
    sub: '11111111-1111-4111-8111-111111111111',
    userId: '11111111-1111-4111-8111-111111111111',
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['ledger:read'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 600_000),
  } as Parameters<typeof encodePrincipal>[0]);
  return { [EDGE_PRINCIPAL_HEADER]: raw, [EDGE_SIGNATURE_HEADER]: signPrincipalHeader(raw, secret, 'DE'), 'x-intafaced-region': 'DE' };
}

afterEach(async () => {
  for (const job of booted.jobs) job.stop();
  booted.jobs.length = 0;
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  servers.length = 0;
  vi.unstubAllEnvs();
});

describe('svc-mining-pool server.ts, booted', () => {
  it('with a database, a ledger and a payout interval: /health and /ready are configured and unprobed, never wired', async () => {
    const get = await boot({
      DATABASE_URL: 'postgres://mining@127.0.0.1:1/test',
      LEDGER_URL: 'http://127.0.0.1:1',
      INTERNAL_SERVICE_SECRET: 'i'.repeat(32),
      MINING_PAYOUT_INTERVAL_MS: '60000',
    });
    const expected = miningHealthHonesty({ ledgerConfigured: true, pgConfigured: true, jobs: [MINING_EPOCH_PAYOUT_JOB] });
    for (const path of ['/health', '/ready']) {
      const answer = await get(path);
      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.text)).toEqual(expected);
      expect(answer.text).not.toMatch(/wired/);
    }
    // The payout runs only as the one scheduled job, at the published interval; booting posts nothing.
    expect(booted.intervals).toEqual([60_000]);
    expect(booted.posts).toEqual([]);
  });

  it('with nothing set: ledger and pg are absent, no job is scheduled', async () => {
    const get = await boot({});
    const answer = await get('/health');
    expect(JSON.parse(answer.text)).toEqual(miningHealthHonesty({ ledgerConfigured: false, pgConfigured: false, jobs: [] }));
    expect(answer.text).not.toMatch(/wired/);
    expect(booted.intervals).toEqual([]);
  });

  it('an unpublished payout interval schedules no payout job even with a database and a ledger', async () => {
    const get = await boot({
      DATABASE_URL: 'postgres://mining@127.0.0.1:1/test',
      LEDGER_URL: 'http://127.0.0.1:1',
      INTERNAL_SERVICE_SECRET: 'i'.repeat(32),
    });
    expect(JSON.parse((await get('/health')).text)).toMatchObject({ jobs: [] });
    expect(booted.intervals).toEqual([]);
  });

  it('hands EDGE_PRINCIPAL_SECRET to the request handler: a miner signed with it gets past sign-in, another secret is refused', async () => {
    // An attributed empty screening answer, so a miner the edge context accepts reaches the read.
    const get = await boot({ [SANCTIONS_REGIONS_ENV]: SCREENING_REVIEWED_EMPTY, [SANCTIONS_SOURCE_ENV]: 'counsel-memo-ref' });
    const url = `/trpc/workers.mine?input=${encodeURIComponent(JSON.stringify({}))}`;
    const accepted = await get(url, signedAs('s'.repeat(32)));
    const refused = await get(url, signedAs('o'.repeat(32)));
    // Signed in: the read goes on to refuse its unpublished hashrate window by name.
    expect(accepted.status).toBe(412);
    expect(accepted.text).toContain('mining.hashrate_window_unset');
    // Another secret's signature carries no miner: the read refuses as signed out.
    expect(refused.status).toBe(401);
    expect(refused.text).toContain('UNAUTHORIZED');
  });
});
