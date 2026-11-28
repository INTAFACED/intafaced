/**
 * svc-ops's own entrypoint, booted: `index.ts` imported with its env (no database, no bus) and its app driven by inject,
 * the way the edge reaches it. What this proves is what the started process serves (its health and readiness), not what
 * its source text says.
 */
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPS_IDENTITY_UNWIRED, OPS_SUPPORT_UNWIRED } from './codes.js';
import { OPS_IDENTITY_UNPROBED, opsReadyUrlHonesty } from './ready-honesty.js';

const booted = vi.hoisted(() => ({ apps: [] as FastifyInstance[] }));

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
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) vi.stubEnv(key, value);
  await import('./index.js');
  const app = booted.apps.at(-1);
  if (!app) throw new Error('index.ts built no app');
  return app;
}

afterEach(async () => {
  for (const app of booted.apps) await app.close();
  booted.apps.length = 0;
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
});
