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
  encodePrincipal,
  signPrincipalHeader,
  signPrincipalHeaderEd25519,
} from '@intafaced/contracts';
import { PROTOCOL_CHAIN_UNPROBED, protocolHealthHonesty } from './health-honesty.js';

/** The tRPC router index.ts mounts, and where: read to ask every query it serves. */
type ServedTrpc = { prefix: string; router: { _def: { procedures: Record<string, { _def: { type: string } }> } } };

const booted = vi.hoisted(() => ({
  apps: [] as FastifyInstance[],
  routes: [] as Array<{ method: string | string[]; url: string }>,
  trpc: [] as ServedTrpc[],
}));

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
vi.mock('@trpc/server/adapters/fastify', async (importOriginal) => {
  const real = await importOriginal<typeof import('@trpc/server/adapters/fastify')>();
  const plugin = ((fastify, opts, done) => {
    booted.trpc.push({ prefix: opts.prefix ?? '', router: opts.trpcOptions.router as unknown as ServedTrpc['router'] });
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
  booted.routes.length = 0;
  booted.trpc.length = 0;
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) vi.stubEnv(key, value);
  const index = await import('./index.js');
  const app = booted.apps.at(-1);
  if (!app) throw new Error('index.ts built no app');
  return { app, index };
}

/** An empty address report from an edge-signed person: one it accepts reaches the input check; one it does not is unauthorized. */
async function reportAs(app: FastifyInstance, maxLifetimeSeconds = 120, hmacSecret?: string) {
  const person = {
    sub: ACCOUNT,
    userId: ACCOUNT,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['protocol:read', 'protocol:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 600_000),
  } as Parameters<typeof encodeForwardedPrincipal>[0];
  // With a shared secret, the edge signs the plain principal with HMAC; with its key pair, the forwarded one with Ed25519.
  const raw = hmacSecret === undefined ? encodeForwardedPrincipal(person, maxLifetimeSeconds) : encodePrincipal(person);
  const res = await app.inject({
    method: 'POST',
    url: '/trpc/addressReports.submit',
    payload: {},
    headers: {
      [EDGE_PRINCIPAL_HEADER]: raw,
      [EDGE_SIGNATURE_HEADER]:
        hmacSecret === undefined ? signPrincipalHeaderEd25519(raw, edge.privateKey, 'DE') : signPrincipalHeader(raw, hmacSecret, 'DE'),
      'x-intafaced-region': 'DE',
    },
  });
  return (res.json() as { error?: { data?: { code?: string } } }).error?.data?.code ?? `ok ${res.statusCode}`;
}

/** What the booted process can answer: every plain GET route it registers and every query of its router, asked anonymously. */
async function everyAnswer(app: FastifyInstance): Promise<Array<{ url: string; status: number; text: string }>> {
  const served = booted.trpc.at(-1);
  if (!served) throw new Error('index.ts mounted no tRPC router');
  const urls = booted.routes.filter((route) => [route.method].flat().includes('GET') && !/[:*]/.test(route.url)).map((route) => route.url);
  for (const [name, procedure] of Object.entries(served.router._def.procedures)) {
    if (procedure._def.type === 'query') urls.push(`${served.prefix}/${name}`);
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

  it('hands EDGE_PRINCIPAL_SECRET to the edge context: a person signed with it is accepted, one signed with another secret is not', async () => {
    const { app } = await boot({ EDGE_PRINCIPAL_PUBLIC_KEY: undefined });
    expect(await reportAs(app, 120, BASE_ENV.EDGE_PRINCIPAL_SECRET)).toBe('BAD_REQUEST');
    expect(await reportAs(app, 120, 'o'.repeat(32))).toBe('UNAUTHORIZED');
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

  it('every answer it gives, each GET route it registers and each query of its router, carries no custodial:false stamp', async () => {
    const app = await boot().then((started) => started.app);
    const answers = await everyAnswer(app);
    expect(answers.map((answer) => answer.url)).toEqual(expect.arrayContaining(['/health', '/trpc/health']));
    expect(answers.length).toBeGreaterThan(3);
    const stamped = answers.filter((answer) => /"custodial":\s*false|non-custodial by construction/i.test(answer.text));
    expect(stamped.map((answer) => answer.url)).toEqual([]);
  });
});
