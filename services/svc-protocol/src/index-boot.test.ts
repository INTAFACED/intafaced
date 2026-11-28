/**
 * svc-protocol's own entrypoint, booted: `index.ts` imported with its env, over a database whose every table check
 * answers present, an in-memory bus and a chain observer that does not poll, and its app driven by inject, the way the edge reaches it. What this proves is what the started process serves and
 * trusts, not what its source text says.
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
import { PROTOCOL_CHAIN_UNPROBED, protocolHealthHonesty } from './health-honesty.js';

const booted = vi.hoisted(() => ({ apps: [] as FastifyInstance[] }));

/** A database whose boot checks find every table; no query reaches a real store. */
vi.mock('@intafaced/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@intafaced/db')>();
  const sql = new Proxy(() => undefined, {
    apply: () => Promise.resolve([{ exists: true }]),
    get: (_t, key) => (key === 'then' ? undefined : () => Promise.resolve([])),
  });
  return { ...real, createDb: () => ({ sql, drizzle: {}, close: async () => undefined }) };
});
vi.mock('@intafaced/events', async (importOriginal) => {
  const real = await importOriginal<typeof import('@intafaced/events')>();
  return { ...real, JetStreamEventBus: { connect: async () => new real.MemoryEventBus('svc-protocol') } };
});
/** The observer watches the chain once started; this boot has no chain to watch. */
vi.mock('./events.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./events.js')>();
  class IdleObserver {
    start(): void {}
    stop(): void {}
  }
  return { ...real, ChainObserver: IdleObserver };
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
  APP_ENV: 'test',
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/never',
  DATABASE_POOL_MAX: '1',
  PROTOCOL_CHAIN_ID: '1',
  PROTOCOL_RPC_URL: 'http://127.0.0.1:1',
  PROTOCOL_ENTRYPOINT_ADDRESS: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  EDGE_PRINCIPAL_SECRET: 's'.repeat(32),
  HTTP_HOST: '127.0.0.1',
  HTTP_PORT: '4996',
  LOG_LEVEL: 'fatal',
  OTEL_ENABLED: 'false',
  // The screening gate is another door's test; here a person the edge context accepts must reach the read.
  INTAFACED_SCREENING_FAIL_CLOSED: 'off',
};

async function boot(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  booted.apps.length = 0;
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) vi.stubEnv(key, value);
  const index = await import('./index.js');
  const app = booted.apps.at(-1);
  if (!app) throw new Error('index.ts built no app');
  return { app, index };
}

/** An empty address report from an edge-signed person: one it accepts reaches the input check; one it does not is unauthorized. */
async function reportAs(app: FastifyInstance, maxLifetimeSeconds = 120) {
  const raw = encodeForwardedPrincipal(
    {
      sub: ACCOUNT,
      userId: ACCOUNT,
      sid: '22222222-2222-4222-8222-222222222222',
      scopes: ['protocol:read', 'protocol:write'],
      tier: 'basic',
      mfa: false,
      expiresAt: new Date(Date.now() + 600_000),
    } as Parameters<typeof encodeForwardedPrincipal>[0],
    maxLifetimeSeconds,
  );
  const res = await app.inject({
    method: 'POST',
    url: '/trpc/addressReports.submit',
    payload: {},
    headers: {
      [EDGE_PRINCIPAL_HEADER]: raw,
      [EDGE_SIGNATURE_HEADER]: signPrincipalHeaderEd25519(raw, edge.privateKey, 'DE'),
      'x-intafaced-region': 'DE',
    },
  });
  return (res.json() as { error?: { data?: { code?: string } } }).error?.data?.code ?? `ok ${res.statusCode}`;
}

afterEach(async () => {
  for (const app of booted.apps) await app.close();
  booted.apps.length = 0;
  vi.unstubAllEnvs();
});

describe('svc-protocol index.ts, booted', () => {
  it('hands the edge public key and its limits to the edge context: an edge-signed person is accepted', async () => {
    const { app } = await boot({
      EDGE_PRINCIPAL_PUBLIC_KEY: edge.publicKey,
      EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS: '120',
      EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS: '10',
    });
    expect(await reportAs(app)).toBe('BAD_REQUEST');
    expect(await reportAs(app, 300)).toBe('UNAUTHORIZED');
  });

  it('without the public key, the same edge-signed person is refused', async () => {
    const { app } = await boot({ EDGE_PRINCIPAL_PUBLIC_KEY: undefined });
    expect(await reportAs(app)).toBe('UNAUTHORIZED');
  });

  it('serves /health and the health procedure from protocolHealthHonesty: the chain id is never echoed as the chain', async () => {
    const { app, index } = await boot({ PROTOCOL_CHAIN_ID: '31337' });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toEqual(
      protocolHealthHonesty({ relayEnabled: body.relayEnabled === true, factoryConfigured: false, venueVaultConfigured: false }),
    );
    expect(body.chain).toEqual({ status: 'unprobed', code: PROTOCOL_CHAIN_UNPROBED, observedChainId: null });
    expect(body).not.toHaveProperty('chainId');
    expect(body).not.toHaveProperty('custodial');
    expect(JSON.stringify(body)).not.toMatch(/31337/);

    const anonymous = index.appRouter.createCaller({ principal: null, service: null, region: 'DE', requestId: 'req-health' });
    const viaRouter = await anonymous.health();
    expect(viaRouter).toEqual(protocolHealthHonesty({ relayEnabled: viaRouter.relayEnabled, factoryConfigured: false }));
    expect(viaRouter).not.toHaveProperty('chainId');
    expect(JSON.stringify(viaRouter)).not.toMatch(/31337/);
  });
});
