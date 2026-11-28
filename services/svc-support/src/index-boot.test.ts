/**
 * svc-support's own entrypoint, booted: `index.ts` imported with its env, over a database and a bus that answer
 * nothing, and its app driven through the edge headers a request arrives with. What this proves is what the process
 * does once started (which trust settings its edge context holds), not what its source text says.
 */
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodeForwardedPrincipal,
  generateEdgePrincipalKeyPair,
  signPrincipalHeaderEd25519,
} from '@intafaced/contracts';

const booted = vi.hoisted(() => ({ apps: [] as FastifyInstance[] }));

/** A database that answers every query with no rows: enough for the boot's schema checks, never a real store. */
vi.mock('postgres', () => {
  const answer = (): unknown =>
    new Proxy(() => undefined, {
      apply: () => Promise.resolve([]),
      get: (_t, key) => (key === 'then' ? undefined : () => Promise.resolve([])),
    });
  return { default: () => answer() };
});
vi.mock('@intafaced/events', async (importOriginal) => {
  const real = await importOriginal<typeof import('@intafaced/events')>();
  return {
    ...real,
    JetStreamEventBus: { connect: () => Promise.reject(new Error('TEST: no bus in this boot')) },
  };
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

const USER = '11111111-1111-4111-8111-111111111111';
const edge = generateEdgePrincipalKeyPair();
const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/never',
  DATABASE_POOL_MAX: '1',
  EDGE_PRINCIPAL_SECRET: 's'.repeat(32),
  INTERNAL_SERVICE_SECRET: 'i'.repeat(32),
  HTTP_HOST: '127.0.0.1',
  HTTP_PORT: '4999',
  LOG_LEVEL: 'fatal',
  OTEL_ENABLED: 'false',
};

async function boot(overrides: Record<string, string | undefined>): Promise<FastifyInstance> {
  vi.resetModules();
  booted.apps.length = 0;
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) vi.stubEnv(key, value);
  await import('./index.js');
  const app = booted.apps.at(-1);
  if (!app) throw new Error('index.ts built no app');
  return app;
}

/** listMine with no page size: a person it accepts meets the named page refusal; one it does not is unauthorized. */
async function listMineAs(app: FastifyInstance, maxLifetimeSeconds = 120) {
  const raw = encodeForwardedPrincipal(
    {
      sub: USER,
      userId: USER,
      sid: '22222222-2222-4222-8222-222222222222',
      scopes: ['support:read', 'support:write'],
      tier: 'basic',
      mfa: false,
      expiresAt: new Date(Date.now() + 600_000),
    } as Parameters<typeof encodeForwardedPrincipal>[0],
    maxLifetimeSeconds,
  );
  const res = await app.inject({
    method: 'GET',
    url: `/trpc/listMine?input=${encodeURIComponent(JSON.stringify({}))}`,
    headers: {
      [EDGE_PRINCIPAL_HEADER]: raw,
      [EDGE_SIGNATURE_HEADER]: signPrincipalHeaderEd25519(raw, edge.privateKey, 'DE'),
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

describe('svc-support index.ts, booted', () => {
  it('hands the edge public key and its limits to the edge context: an edge-signed person is accepted', async () => {
    const app = await boot({
      EDGE_PRINCIPAL_PUBLIC_KEY: edge.publicKey,
      EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS: '120',
      EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS: '10',
    });
    expect(await listMineAs(app)).toBe('PRECONDITION_FAILED');
    // Past the configured lifetime, the same key is refused: the limit reached the context too.
    expect(await listMineAs(app, 300)).toBe('UNAUTHORIZED');
  });

  it('without the public key, the same edge-signed person is refused', async () => {
    const app = await boot({ EDGE_PRINCIPAL_PUBLIC_KEY: undefined });
    expect(await listMineAs(app)).toBe('UNAUTHORIZED');
  });
});
