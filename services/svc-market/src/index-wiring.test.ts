/**
 * Boots svc-market's start-up module (`index.ts`) with its database stubbed, then checks what it built and what its
 * app answers. Replaces pins that read `index.ts` as text: the affiliate legs reach identity through their clients,
 * the edge context gets the edge's trust settings, and /ready serves marketReadyHonesty without calling anyone.
 */
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateEdgePrincipalKeyPair } from '@intafaced/contracts';
import { marketReadyHonesty } from './ready-honesty.js';

const booted = vi.hoisted(() => ({
  apps: [] as FastifyInstance[],
  commerceConfig: [] as Record<string, unknown>[],
  accrueClients: [] as unknown[][],
  payoutClients: [] as unknown[][],
  edgeOptions: [] as Record<string, unknown>[],
  accrueClient: { kind: 'affiliate-accrue-client', accrueMarketFee: async () => undefined },
  payoutClient: { kind: 'affiliate-payout-client', payoutMarketFee: async () => undefined },
}));

vi.mock('fastify', async (importOriginal) => {
  const real = (await importOriginal<typeof import('fastify')>()).default;
  return {
    default: (opts?: FastifyServerOptions) => {
      const app = real(opts);
      (app as { listen: unknown }).listen = async () => {
        await app.ready();
        return '';
      };
      booted.apps.push(app);
      return app;
    },
  };
});

vi.mock('postgres', () => ({
  default: () => {
    const sql = Object.assign(() => Promise.resolve([]), {
      json: (v: unknown) => v,
      end: async () => undefined,
      begin: async (mode: unknown, fn?: (tx: unknown) => unknown): Promise<unknown> => (typeof mode === 'function' ? mode(sql) : fn?.(sql)),
      unsafe: (text: string) => ({ unsafe: text }),
    });
    return sql;
  },
}));

vi.mock('@intafaced/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@intafaced/telemetry')>()),
  registerProcessHooks: () => undefined,
}));

vi.mock('./affiliate-accrue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./affiliate-accrue.js')>()),
  createAffiliateAccrueClient: (...args: unknown[]) => {
    booted.accrueClients.push(args);
    return booted.accrueClient;
  },
}));

vi.mock('./affiliate-payout.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./affiliate-payout.js')>()),
  createAffiliatePayoutClient: (...args: unknown[]) => {
    booted.payoutClients.push(args);
    return booted.payoutClient;
  },
}));

vi.mock('./commerce/commerce-service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./commerce/commerce-service.js')>();
  class RecordingCommerceService extends real.CommerceService {
    constructor(...args: ConstructorParameters<typeof real.CommerceService>) {
      super(...args);
      booted.commerceConfig.push({ ...args[3] });
    }
  }
  return { ...real, CommerceService: RecordingCommerceService };
});

vi.mock('@intafaced/contracts/edge', async (importOriginal) => {
  const real = await importOriginal<typeof import('@intafaced/contracts/edge')>();
  return {
    ...real,
    createEdgeContext: (options: Parameters<typeof real.createEdgeContext>[0]) => {
      booted.edgeOptions.push({ ...options });
      return real.createEdgeContext(options);
    },
  };
});

const SECRET = 'svc-market-boot-internal-secret-000000001';
const EDGE_SECRET = 'svc-market-boot-edge-secret-00000000000001';

async function boot(overrides: Record<string, string | undefined> = {}): Promise<FastifyInstance> {
  vi.resetModules();
  vi.unstubAllEnvs();
  const base: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    APP_ENV: 'test',
    LOG_LEVEL: 'fatal',
    OTEL_ENABLED: 'false',
    DATABASE_URL: 'postgres://boot:boot@127.0.0.1:9/boot',
    DATABASE_POOL_MAX: '1',
    EDGE_PRINCIPAL_SECRET: EDGE_SECRET,
    INTERNAL_SERVICE_SECRET: SECRET,
    LEDGER_URL: 'http://ledger.test',
    TOKEN_URL: 'http://token.test',
    IDENTITY_URL: 'http://identity.test',
    MARKET_RELEASE_SWEEP_SECONDS: undefined,
    EDGE_PRINCIPAL_PUBLIC_KEY: undefined,
    EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS: undefined,
    EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS: undefined,
  };
  for (const [key, value] of Object.entries({ ...base, ...overrides })) vi.stubEnv(key, value);
  await import('./index.js');
  const app = booted.apps.at(-1);
  if (!app) throw new Error('index.ts built no app');
  return app;
}

afterEach(async () => {
  for (const app of booted.apps) await app.close();
  for (const list of [booted.apps, booted.commerceConfig, booted.accrueClients, booted.payoutClients, booted.edgeOptions]) {
    list.length = 0;
  }
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('svc-market start-up wiring', () => {
  it('hands the purchase flow the identity affiliate accrue and payout clients, built from IDENTITY_URL', async () => {
    await boot();
    expect(booted.accrueClients).toHaveLength(1);
    expect(booted.accrueClients[0]!.slice(0, 2)).toEqual(['http://identity.test', SECRET]);
    expect(booted.payoutClients).toHaveLength(1);
    expect(booted.payoutClients[0]!.slice(0, 2)).toEqual(['http://identity.test', SECRET]);
    expect(booted.commerceConfig).toHaveLength(1);
    expect(booted.commerceConfig[0]!.affiliateAccrue).toBe(booted.accrueClient);
    expect(booted.commerceConfig[0]!.affiliatePayout).toBe(booted.payoutClient);
  });

  it('with no IDENTITY_URL the purchase flow gets no affiliate client', async () => {
    await boot({ IDENTITY_URL: undefined });
    expect(booted.accrueClients).toHaveLength(0);
    expect(booted.payoutClients).toHaveLength(0);
    expect(booted.commerceConfig[0]!.affiliateAccrue).toBeUndefined();
    expect(booted.commerceConfig[0]!.affiliatePayout).toBeUndefined();
  });

  it('index.ts hands the edge trust settings to the edge context', async () => {
    const key = generateEdgePrincipalKeyPair().publicKey;
    await boot({ EDGE_PRINCIPAL_PUBLIC_KEY: key, EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS: '120', EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS: '5' });
    expect(booted.edgeOptions).toHaveLength(1);
    expect(booted.edgeOptions[0]).toMatchObject({
      secret: EDGE_SECRET,
      edgePublicKey: key,
      principalLimits: { maxLifetimeSeconds: 120, clockSkewSeconds: 5 },
      serviceName: 'svc-market',
    });
  });

  it('without a public key the edge context keeps the shared secret alone', async () => {
    await boot();
    expect(booted.edgeOptions[0]).toMatchObject({ secret: EDGE_SECRET, serviceName: 'svc-market' });
    expect(booted.edgeOptions[0]).not.toHaveProperty('edgePublicKey');
  });

  it('serves marketReadyHonesty on /ready, not a bare ready:true stamp, and calls nobody to answer it', async () => {
    const app = await boot({ IDENTITY_URL: undefined });
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(
      JSON.parse(
        JSON.stringify(
          marketReadyHonesty({
            databaseUrl: 'postgres://boot:boot@127.0.0.1:9/boot',
            ledgerUrl: 'http://ledger.test',
            tokenUrl: 'http://token.test',
            identityUrl: undefined,
            commissionConfigured: false,
          }),
        ),
      ),
    );
    expect(res.json()).toHaveProperty('identity');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
