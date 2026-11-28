/**
 * svc-ops's own entrypoint, booted: `index.ts` imported with its env (no database, no bus) and its app driven by inject,
 * the way the edge reaches it. What this proves is what the started process serves (its health and readiness), not what
 * its source text says.
 */
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { AnyRouter } from '@trpc/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EDGE_PRINCIPAL_HEADER, EDGE_SIGNATURE_HEADER, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { OPS_IDENTITY_UNWIRED, OPS_SUPPORT_UNWIRED } from './codes.js';
import { OPS_IDENTITY_UNPROBED, opsReadyUrlHonesty } from './ready-honesty.js';

/** The tRPC router index.ts mounts, and where: read to ask every query it serves. */
type ServedTrpc = { prefix: string; router: AnyRouter };

const booted = vi.hoisted(() => ({
  apps: [] as FastifyInstance[],
  routes: [] as Array<{ method: string | string[]; url: string }>,
  trpc: [] as ServedTrpc[],
}));

vi.mock('@trpc/server/adapters/fastify', async (importOriginal) => {
  const real = await importOriginal<typeof import('@trpc/server/adapters/fastify')>();
  const plugin = ((fastify, opts, done) => {
    booted.trpc.push({ prefix: opts.prefix ?? '', router: opts.trpcOptions.router });
    return real.fastifyTRPCPlugin(fastify, opts, done);
  }) as typeof real.fastifyTRPCPlugin;
  Object.defineProperties(plugin, Object.getOwnPropertyDescriptors(real.fastifyTRPCPlugin));
  return { ...real, fastifyTRPCPlugin: plugin };
});
vi.mock('fastify', async (importOriginal) => {
  const real = await importOriginal<typeof import('fastify')>();
  const make = ((options?: FastifyServerOptions) => {
    const app = real.default(options);
    // The boot is driven by inject: no port is opened.
    Object.defineProperty(app, 'listen', { value: async () => '' });
    booted.apps.push(app);
    app.addHook('onRoute', (route) => void booted.routes.push({ method: route.method, url: route.url }));
    return app;
  }) as typeof real.default;
  return { ...real, default: make };
});

const BASE_ENV = {
  NODE_ENV: 'test',
  APP_ENV: 'test',
  DATABASE_URL: undefined,
  NATS_URL: undefined,
  LEDGER_URL: undefined,
  SUPPORT_URL: undefined,
  OPS_TEST_VENUE: undefined,
  OPS_VALUATION_TEST_PRICES: undefined,
  EDGE_PRINCIPAL_SECRET: 's'.repeat(32),
  INTERNAL_SERVICE_SECRET: 'i'.repeat(32),
  HTTP_HOST: '127.0.0.1',
  HTTP_PORT: '4997',
  LOG_LEVEL: 'fatal',
  OTEL_ENABLED: 'false',
};

async function boot(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  booted.apps.length = 0;
  booted.routes.length = 0;
  booted.trpc.length = 0;
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) vi.stubEnv(key, value);
  await import('./index.js');
  const app = booted.apps.at(-1);
  if (!app) throw new Error('index.ts built no app');
  return app;
}

/** The contacts desk as an operator the edge signed with `secret`: the answer names who the door saw. */
async function contactsAs(app: FastifyInstance, secret: string) {
  const raw = encodePrincipal({
    sub: '11111111-1111-4111-8111-111111111111',
    userId: '11111111-1111-4111-8111-111111111111',
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['admin:read', 'admin:write'],
    tier: 'none',
    mfa: true,
    expiresAt: new Date(Date.now() + 600_000),
  } as Parameters<typeof encodePrincipal>[0]);
  const res = await app.inject({
    method: 'GET',
    url: `/trpc/contacts?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`,
    headers: {
      [EDGE_PRINCIPAL_HEADER]: raw,
      [EDGE_SIGNATURE_HEADER]: signPrincipalHeader(raw, secret, 'DE'),
      'x-intafaced-region': 'DE',
    },
  });
  return { code: (res.json() as { error?: { data?: { code?: string } } }).error?.data?.code, text: res.body };
}

/** A tRPC procedure that answers a GET: a query. */
function isQuery(procedure: unknown): boolean {
  if (typeof procedure !== 'function' || !('_def' in procedure)) return false;
  const def: unknown = procedure._def;
  return typeof def === 'object' && def !== null && 'type' in def && def.type === 'query';
}

/** What the booted process can answer: every plain GET route it registers and every query of its router, asked anonymously. */
async function everyAnswer(app: FastifyInstance): Promise<Array<{ url: string; status: number; text: string }>> {
  const served = booted.trpc.at(-1);
  if (!served) throw new Error('index.ts mounted no tRPC router');
  const urls = booted.routes.filter((route) => [route.method].flat().includes('GET') && !/[:*]/.test(route.url)).map((route) => route.url);
  for (const [name, procedure] of Object.entries(served.router._def.procedures)) {
    if (isQuery(procedure)) urls.push(`${served.prefix}/${name}`);
  }
  const answers: Array<{ url: string; status: number; text: string }> = [];
  for (const url of [...new Set(urls)].sort()) {
    const res = await app.inject({ method: 'GET', url, headers: { 'x-intafaced-region': 'DE' } });
    answers.push({ url, status: res.statusCode, text: res.body });
  }
  return answers;
}

afterEach(async () => {
  for (const app of booted.apps) await app.close();
  booted.apps.length = 0;
  booted.routes.length = 0;
  booted.trpc.length = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('svc-ops index.ts, booted', () => {
  it('serves /ready from opsReadyUrlHonesty: a set IDENTITY_URL is configured and unprobed, never a live peer', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch');
    const app = await boot({ IDENTITY_URL: 'http://identity.test' });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ready: true, ...opsReadyUrlHonesty({ IDENTITY_URL: 'http://identity.test' }) });
    expect(body.identity).toEqual({ status: 'configured', code: OPS_IDENTITY_UNPROBED });
    expect(body.support).toEqual({ status: 'absent', code: OPS_SUPPORT_UNWIRED });
    expect(body.identitySource).toBe('hardcoded-absent');
    expect(body.supportSource).toBe('hardcoded-absent');
    for (const key of ['custodial', 'identityUrl', 'supportUrl']) expect(body).not.toHaveProperty(key);
    expect(res.body).not.toMatch(/identity\.test/);
    // Readiness is read from config: neither booting nor answering asks a peer.
    expect(fetched).not.toHaveBeenCalled();
  });

  it('with no peer URLs, /ready names both absent and unwired', async () => {
    const app = await boot({ IDENTITY_URL: undefined });
    const body = (await app.inject({ method: 'GET', url: '/ready' })).json() as Record<string, unknown>;
    expect(body).toMatchObject({ ready: true, ...opsReadyUrlHonesty({}) });
    expect(body.identity).toEqual({ status: 'absent', code: OPS_IDENTITY_UNWIRED });
    expect(body).not.toHaveProperty('custodial');
  });

  it('/health and the router health it serves answer ok + service only, no custodial stamp', async () => {
    const app = await boot({ IDENTITY_URL: undefined });
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.json()).toEqual({ ok: true, service: 'svc-ops' });
    const trpc = await app.inject({ method: 'GET', url: '/trpc/health' });
    expect(trpc.statusCode).toBe(200);
    expect((trpc.json() as { result: { data: unknown } }).result.data).toEqual({ ok: true, service: 'svc-ops' });
    expect(`${health.body}${trpc.body}`).not.toMatch(/custodial/);
  });

  it('hands EDGE_PRINCIPAL_SECRET to the edge context: an operator signed with it gets past sign-in, another secret is refused', async () => {
    const app = await boot({ IDENTITY_URL: undefined });
    const accepted = await contactsAs(app, BASE_ENV.EDGE_PRINCIPAL_SECRET);
    // Signed in: the door goes on to read the operator entitlement, which this boot has no identity service for.
    expect(accepted.code).toBe('SERVICE_UNAVAILABLE');
    expect(accepted.text).toContain('operator.authority_unavailable');
    expect((await contactsAs(app, 'o'.repeat(32))).code).toBe('UNAUTHORIZED');
  });

  it('every answer it gives, each GET route it registers and each query of its router, carries no custodial:false stamp and asks no peer', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch');
    const app = await boot({ IDENTITY_URL: 'http://identity.test' });
    const answers = await everyAnswer(app);
    expect(fetched).not.toHaveBeenCalled();
    expect(answers.map((answer) => answer.url)).toEqual(expect.arrayContaining(['/health', '/trpc/health']));
    expect(answers.length).toBeGreaterThan(3);
    const stamped = answers.filter((answer) => /"custodial":\s*false|non-custodial by construction/i.test(answer.text));
    expect(stamped.map((answer) => answer.url)).toEqual([]);
  });
});
