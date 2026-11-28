/**
 * svc-quant's own entrypoint, booted: `index.ts` imported with its env (no database, a bus that never answers) and its
 * app driven by inject, the way the edge reaches it. What this proves is what the started process serves and
 * trusts, not what its source text says.
 */
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodeForwardedPrincipal,
  generateEdgePrincipalKeyPair,
  encodePrincipal,
  signPrincipalHeader,
  signPrincipalHeaderEd25519,
} from '@intafaced/contracts';
import { missingLake } from './backtest/lake.js';
import { quantReadyHonesty } from './ready-honesty.js';

const booted = vi.hoisted(() => ({ apps: [] as FastifyInstance[] }));

vi.mock('@intafaced/events', async (importOriginal) => {
  const real = await importOriginal<typeof import('@intafaced/events')>();
  return { ...real, JetStreamEventBus: { connect: () => Promise.reject(new Error('TEST: no bus in this boot')) } };
});
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

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const edge = generateEdgePrincipalKeyPair();
const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: undefined,
  DATABASE_POOL_MAX: undefined,
  TRADE_URL: undefined,
  QUANT_VENUE_VAULT: undefined,
  EDGE_PRINCIPAL_SECRET: 's'.repeat(32),
  HTTP_HOST: '127.0.0.1',
  HTTP_PORT: '4998',
  LOG_LEVEL: 'fatal',
  OTEL_ENABLED: 'false',
};

async function boot(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  booted.apps.length = 0;
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) vi.stubEnv(key, value);
  const index = await import('./index.js');
  const app = booted.apps.at(-1);
  if (!app) throw new Error('index.ts built no app');
  return { app, appRouter: index.appRouter };
}

/** studio.list with no page size: a person it accepts meets the named page refusal; one it does not is unauthorized. */
async function studioListAs(app: FastifyInstance, maxLifetimeSeconds = 120, hmacSecret?: string) {
  const person = {
    sub: ACCOUNT,
    userId: ACCOUNT,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 600_000),
  } as Parameters<typeof encodeForwardedPrincipal>[0];
  // With a shared secret, the edge signs the plain principal with HMAC; with its key pair, the forwarded one with Ed25519.
  const raw = hmacSecret === undefined ? encodeForwardedPrincipal(person, maxLifetimeSeconds) : encodePrincipal(person);
  const res = await app.inject({
    method: 'GET',
    url: `/trpc/studio.list?input=${encodeURIComponent(JSON.stringify({}))}`,
    headers: {
      [EDGE_PRINCIPAL_HEADER]: raw,
      [EDGE_SIGNATURE_HEADER]:
        hmacSecret === undefined ? signPrincipalHeaderEd25519(raw, edge.privateKey, 'DE') : signPrincipalHeader(raw, hmacSecret, 'DE'),
      'x-intafaced-region': 'DE',
    },
  });
  return (res.json() as { error?: { data?: { code?: string } } }).error?.data?.code;
}

afterEach(async () => {
  for (const app of booted.apps) await app.close();
  booted.apps.length = 0;
  vi.unstubAllEnvs();
});

describe('svc-quant index.ts, booted', () => {
  it('hands the edge public key and its limits to the edge context: an edge-signed person is accepted', async () => {
    const { app } = await boot({
      EDGE_PRINCIPAL_PUBLIC_KEY: edge.publicKey,
      EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS: '120',
      EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS: '10',
    });
    expect(await studioListAs(app)).toBe('PRECONDITION_FAILED');
    expect(await studioListAs(app, 300)).toBe('UNAUTHORIZED');
  });

  it('without the public key, the same edge-signed person is refused', async () => {
    const { app } = await boot({ EDGE_PRINCIPAL_PUBLIC_KEY: undefined });
    expect(await studioListAs(app)).toBe('UNAUTHORIZED');
  });

  it('hands EDGE_PRINCIPAL_SECRET to the edge context: a person signed with it is accepted, one signed with another secret is not', async () => {
    const { app } = await boot({ EDGE_PRINCIPAL_PUBLIC_KEY: undefined });
    expect(await studioListAs(app, 120, BASE_ENV.EDGE_PRINCIPAL_SECRET)).toBe('PRECONDITION_FAILED');
    expect(await studioListAs(app, 120, 'o'.repeat(32))).toBe('UNAUTHORIZED');
  });

  it('serves /ready from quantReadyHonesty over the missing lake: the isolate is not sold as wired', async () => {
    const { app } = await boot();
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toEqual(quantReadyHonesty({ isolateWired: true, lakeWired: missingLake().wired, venueVaultSet: false }));
    expect(body.isolate).toBe('unwired');
    expect(body.lake).toBe('missing');
    expect(body).not.toHaveProperty('custodial');
  });

  it('allow-lists no service for the studio: a service call with an explicit account is refused', async () => {
    const { appRouter } = await boot();
    const agent = appRouter.createCaller({ principal: null, service: 'svc-agents', region: 'DE', requestId: 's2s' });
    await expect(agent.studio.list({ limit: 50, accountId: ACCOUNT })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
