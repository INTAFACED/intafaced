/**
 * svc-campaigns' own entrypoint, booted: `index.ts` imported with its env (a database client that answers nothing, a
 * bus that never answers, passes that never tick) and its app driven by inject, the way a signed service call reaches it.
 * What this proves is which TEST doors the started process opens and when it reads the flag, not what its source says.
 */
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodePrincipal,
  serviceAuthHeadersForBody,
  signPrincipalHeader,
} from '@intafaced/contracts';
import { TEST_AGE_PATH } from '@intafaced/service-kit';
import { TEST_PAY_FAULT_PATH } from './test-pay-fault.js';

const booted = vi.hoisted(() => ({ apps: [] as FastifyInstance[], databases: 0, queries: [] as string[] }));

vi.mock('postgres', () => ({
  default: () => {
    booted.databases += 1;
    // A client that answers every query with no rows and records what it was asked.
    const sql = (strings: TemplateStringsArray | string) => {
      booted.queries.push(Array.isArray(strings) ? strings.join('?') : String(strings));
      return Promise.resolve([]);
    };
    return new Proxy(sql, { get: (target, key) => (key in target ? Reflect.get(target, key) : () => Promise.resolve([])) });
  },
}));
vi.mock('@intafaced/events', async (importOriginal) => {
  const real = await importOriginal<typeof import('@intafaced/events')>();
  return { ...real, JetStreamEventBus: { connect: () => Promise.reject(new Error('TEST: no bus in this boot')) } };
});
vi.mock('./passes.js', () => ({ startPasses: () => ({ stop: () => undefined }) }));
vi.mock('fastify', async (importOriginal) => {
  const real = await importOriginal<typeof import('fastify')>();
  const make = ((options?: FastifyServerOptions) => {
    const app = real.default(options);
    // The boot is driven by inject: no port is opened.
    Object.defineProperty(app, 'listen', { value: async () => '' });
    booted.apps.push(app);
    return app;
  }) as typeof real.default;
  return { ...real, default: make };
});

const SECRET = 'test-age-door-campaigns-secret-32c';
const BASE_ENV = {
  NODE_ENV: 'test',
  APP_ENV: 'test',
  TEST_AGE_DOOR: undefined,
  DATABASE_URL: 'postgres://campaigns@127.0.0.1:1/campaigns',
  DATABASE_POOL_MAX: '2',
  NATS_URL: 'nats://127.0.0.1:1',
  INTERNAL_SERVICE_SECRET: SECRET,
  EDGE_PRINCIPAL_SECRET: 's'.repeat(32),
  HTTP_HOST: '127.0.0.1',
  HTTP_PORT: '4996',
  LOG_LEVEL: 'fatal',
  OTEL_ENABLED: 'false',
};

async function boot(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  booted.apps.length = 0;
  booted.databases = 0;
  booted.queries.length = 0;
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) vi.stubEnv(key, value);
  await import('./index.js');
  const app = booted.apps.at(-1);
  if (!app) throw new Error('index.ts built no app');
  return app;
}

/** A body-bound signed service call, as the TEST stack's driver sends it. */
function signedPost(app: FastifyInstance, url: string, body: unknown) {
  const payload = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('local-test-stack', SECRET, payload) },
    payload,
  });
}

/** The customer's own campaigns, as a person the edge signed with `secret`: the answer names who the door saw. */
async function myCampaignsAs(app: FastifyInstance, secret: string) {
  const raw = encodePrincipal({
    sub: '11111111-1111-4111-8111-111111111111',
    userId: '11111111-1111-4111-8111-111111111111',
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['campaigns:read'],
    tier: 'basic',
    mfa: true,
    expiresAt: new Date(Date.now() + 600_000),
  } as Parameters<typeof encodePrincipal>[0]);
  const res = await app.inject({
    method: 'GET',
    url: '/trpc/participation.mine',
    headers: {
      [EDGE_PRINCIPAL_HEADER]: raw,
      [EDGE_SIGNATURE_HEADER]: signPrincipalHeader(raw, secret, 'DE'),
      'x-intafaced-region': 'DE',
    },
  });
  return { status: res.statusCode, code: (res.json() as { error?: { data?: { code?: string } } }).error?.data?.code, text: res.body };
}

afterEach(async () => {
  for (const app of booted.apps) await app.close();
  booted.apps.length = 0;
  vi.unstubAllEnvs();
});

const AGE = { subject: 'reward', id: 'task:c1:a1:once', ms: 61_000 };
const FAULT = { rewardKey: 'task:c1:a1:once', fault: 'revert' };

describe('svc-campaigns index.ts, booted', () => {
  it('without TEST_AGE_DOOR: a signed call to either TEST door is refused by name and touches nothing', async () => {
    const app = await boot({});
    const before = booted.queries.length;
    const age = await signedPost(app, TEST_AGE_PATH, AGE);
    expect(age.statusCode).toBe(403);
    expect(age.json()).toMatchObject({ error: 'test_age.door_closed' });
    const fault = await signedPost(app, TEST_PAY_FAULT_PATH, FAULT);
    expect(fault.statusCode).toBe(403);
    expect(fault.json()).toMatchObject({ error: 'test_pay_fault.door_closed' });
    expect(booted.queries.slice(before)).toEqual([]);
  });

  it('with TEST_AGE_DOOR=on on a TEST stack: both doors open behind the signed call, and the age door reads its subject', async () => {
    const app = await boot({ TEST_AGE_DOOR: 'on' });
    const unsigned = await app.inject({ method: 'POST', url: TEST_PAY_FAULT_PATH, payload: FAULT });
    expect(unsigned.statusCode).toBe(401);
    const fault = await signedPost(app, TEST_PAY_FAULT_PATH, FAULT);
    expect(fault.statusCode).toBe(200);
    expect(fault.json()).toEqual({ ...FAULT, label: 'TEST' });
    const before = booted.queries.length;
    const age = await signedPost(app, TEST_AGE_PATH, AGE);
    // The subject asked is the reward one wired on the service's database; this database has no such reward.
    expect(age.json()).toMatchObject({ error: 'test_age.not_found' });
    expect(booted.queries.length).toBeGreaterThan(before);
    // The distribution subject is wired on the same database too.
    const beforeRun = booted.queries.length;
    const run = await signedPost(app, TEST_AGE_PATH, { subject: 'distribution', id: 'distribution-run:none', ms: 61_000 });
    expect(run.json()).toMatchObject({ error: 'test_age.not_found' });
    expect(booted.queries.length).toBeGreaterThan(beforeRun);
  });

  it('TEST_AGE_DOOR=on outside a TEST stack refuses boot before the database is opened', async () => {
    await expect(boot({ TEST_AGE_DOOR: 'on', NODE_ENV: 'production' })).rejects.toThrow(/TEST_AGE_DOOR=on is a TEST stack's door/);
    expect(booted.databases).toBe(0);
    expect(booted.apps).toEqual([]);
  });

  it('hands EDGE_PRINCIPAL_SECRET to the edge context: a person signed with it gets past sign-in, another secret is refused', async () => {
    const app = await boot({});
    const accepted = await myCampaignsAs(app, BASE_ENV.EDGE_PRINCIPAL_SECRET);
    // Signed in: the door goes on to the campaign read, which refuses the unset platform time zone by name.
    expect(accepted.code).toBe('BAD_REQUEST');
    expect(accepted.text).toContain('campaigns.timezone_unset');
    expect((await myCampaignsAs(app, 'o'.repeat(32))).code).toBe('UNAUTHORIZED');
  });
});
