/**
 * R-auth leftover (PTX-M01-R05): API-key mint / exchange / assert must produce
 * a session-or-key stamp a caller can persist onto order/fill/ledger.
 * Unit helpers alone are not a door. Signed-out is attribution_missing, not empty.
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { AuthError, type AuthService } from './auth-service.js';
import { createApiKeyAttributionRouter } from '../api-key-attribution-router.js';
import { ATTRIBUTION_MISSING, attributedSurfaces, installApiKeyAttribution, requireAttribution } from './four-eyes.js';

const EDGE_SECRET = 'identity-api-key-attribution-public-door-secret-32';
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '44444444-4444-4444-8444-444444444444';
const KEY_ID = '55555555-5555-4555-8555-555555555555';

/** The builders and wraps the boot is checked for: each module path, as index.ts imports it, and its export. */
const WATCHED = [
  ['../list-sessions-router.js', 'createListSessionsRouter'],
  ['../session-revoke-router.js', 'createSessionRevokeRouter'],
  ['../panic-revoke-router.js', 'createPanicRevokeRouter'],
  ['../api-key-origin-router.js', 'createApiKeyOriginRouter'],
  ['../api-key-product-router.js', 'createApiKeyProductRouter'],
  ['../api-key-attribution-router.js', 'createApiKeyAttributionRouter'],
  ['../action-approval-router.js', 'createActionApprovalRouter'],
  ['./four-eyes.js', 'installApiKeyAttribution'],
  ['./auth-service-product.js', 'installApiKeyProductExchange'],
] as const;

/** Only what svc-identity's settings refuse to start without: nothing an owner publishes is set. */
const BOOT_ENV: NodeJS.ProcessEnv = {
  APP_ENV: 'test',
  SERVICE_NAME: 'svc-identity',
  DATABASE_URL: 'postgres://boot:boot@localhost:5432/boot',
  DATABASE_POOL_MAX: '1',
  EDGE_PRINCIPAL_SECRET: 'an-identity-boot-edge-secret-long-enough',
  INTERNAL_SERVICE_SECRET: 'an-identity-boot-internal-secret-long-enough',
  JWT_ACCESS_SECRET: 'an-identity-boot-access-secret-long-enough',
  JWT_REFRESH_SECRET: 'an-identity-boot-refresh-secret-long-enough',
};

type Boot = {
  /** The database handle the service made (a stand-in that answers every query with no rows). */
  sql: unknown;
  /** The service's AuthService, as the boot handed it to the attribution wrap. */
  auth: unknown;
  /** Every procedure path of the merged router the service serves. */
  procedures: string[];
  calls(name: (typeof WATCHED)[number][1]): unknown[][];
};

/** The first boot imports the whole service (about 16 s on a quiet machine); later tests reuse it. */
const BOOT_TIMEOUT_MS = 120_000;

let booted: Promise<Boot> | undefined;

/**
 * svc-identity's own boot (index.ts), run once: no database, bus or port. The database and the NATS bus are stand-ins,
 * Fastify never listens, and each watched builder or wrap is the real one, recording how the boot called it.
 */
function bootIdentity(): Promise<Boot> {
  booted ??= (async () => {
    const made: unknown[] = [];
    vi.doMock('postgres', () => ({
      default: () => {
        const fn = (..._args: unknown[]) => Promise.resolve([]);
        const sql = Object.assign(fn, {
          json: (v: unknown) => v,
          begin: async (a: unknown, b?: (tx: unknown) => unknown) => (typeof a === 'function' ? a(fn) : b?.(fn)),
          end: async () => undefined,
          unsafe: () => Promise.resolve([]),
        });
        made.push(sql);
        return sql;
      },
    }));
    vi.doMock('@intafaced/events', async (importOriginal) => {
      const real = await importOriginal<typeof import('@intafaced/events')>();
      return { ...real, JetStreamEventBus: { connect: async () => new real.MemoryEventBus('svc-identity') } };
    });
    vi.doMock('fastify', async (importOriginal) => {
      const real = await importOriginal<typeof import('fastify')>();
      const make = real.default as (...args: unknown[]) => object;
      const quiet = (...args: unknown[]) => Object.assign(make(...args), { listen: async () => '' });
      return { ...real, default: quiet };
    });
    const spies = new Map<string, ReturnType<typeof vi.fn>>();
    for (const [path, name] of WATCHED)
      vi.doMock(path, async (importOriginal) => {
        const real = await importOriginal<Record<string, (...args: unknown[]) => unknown>>();
        const spy = vi.fn(real[name]);
        spies.set(name, spy);
        return { ...real, [name]: spy };
      });
    const savedEnv = process.env;
    process.env = { ...BOOT_ENV };
    vi.resetModules();
    try {
      const index = await import('../index.js');
      const procedures = Object.keys(index.appRouter._def.procedures);
      const calls = (name: string) => spies.get(name)?.mock.calls ?? [];
      const auth = calls('installApiKeyAttribution')[0]?.[0];
      expect((auth as object | undefined)?.constructor.name).toBe('AuthService');
      expect(made).toHaveLength(1);
      return { sql: made[0], auth, procedures, calls };
    } finally {
      process.env = savedEnv;
      for (const mod of ['postgres', '@intafaced/events', 'fastify', ...WATCHED.map(([path]) => path)]) vi.doUnmock(mod);
      vi.resetModules();
    }
  })();
  return booted;
}

type WireBody = {
  result?: { data?: unknown };
  error?: { message?: string; data?: { code?: string; httpStatus?: number } };
};

function unwrapData(body: WireBody): unknown {
  const data = body.result?.data;
  if (data && typeof data === 'object' && 'json' in (data as Record<string, unknown>)) {
    return (data as { json: unknown }).json;
  }
  return data;
}

function principal(scopes = ['identity:read', 'identity:write']): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: SESSION,
    scopes,
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

function signedHeaders(scopes?: string[]): Record<string, string> {
  const raw = encodePrincipal(principal(scopes));
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

function mockAuth(): AuthService {
  const auth = {
    async withApiKeyAction(input: { proof?: unknown }, run: (scope: unknown) => Promise<unknown>) {
      if (!input.proof) throw new AuthError('A fresh confirmation is required. Confirm again.', 'auth.step_up_required');
      return run({ tx: {}, createApiKey: () => auth.createApiKey(), revokeApiKey: async () => true });
    },
    async createApiKey() {
      return { id: KEY_ID, key: 'ifc_live_attribution_key', prefix: 'ifc_live', mode: 'live' as const };
    },
    async exchangeApiKey() {
      return {
        accessToken: 'access-token-from-key',
        expiresAt: new Date('2026-09-04T12:00:00.000Z'),
        userId: USER,
        keyId: KEY_ID,
        scopes: ['trade:write'],
        mode: 'live' as const,
      };
    },
    async assertApiKeyLive(keyId: string) {
      return { id: keyId, userId: USER };
    },
  };
  installApiKeyAttribution(auth as unknown as AuthService);
  return auth as unknown as AuthService;
}

async function mountDoor(auth: AuthService): Promise<FastifyInstance> {
  const router = createApiKeyAttributionRouter(auth);
  const app = Fastify({ logger: false });
  const edgeContext = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-identity' });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router,
      createContext: ({ req }) => edgeContext(req),
    } satisfies FastifyTRPCPluginOptions<typeof router>['trpcOptions'],
  });
  await app.ready();
  return app;
}

describe('API-key attribution public door (PTX-M01-R05)', () => {
  it(
    'boot path hitches AuthService and mounts the live door',
    async () => {
      const boot = await bootIdentity();
      // The service's one AuthService is wrapped for attribution and product scope, and the door is built on it.
      expect(boot.calls('installApiKeyAttribution')).toEqual([[boot.auth]]);
      expect(boot.calls('createApiKeyAttributionRouter')).toEqual([[boot.auth]]);
      expect(boot.calls('installApiKeyProductExchange')).toEqual([[boot.auth, boot.sql]]);
      expect(boot.procedures).toEqual(
        expect.arrayContaining(['attribution.stamp', 'attribution.assert', 'attribution.exchange', 'attribution.mint']),
      );
    },
    BOOT_TIMEOUT_MS,
  );

  /*
   * The boot's other doors, each a sign-in or key door that is only live once index.ts mounts it (each was a helper
   * nobody could reach before). One boot answers for all of them, with their own tests' words.
   */
  it(
    'mergeRouters includes createListSessionsRouter, createSessionRevokeRouter and createPanicRevokeRouter',
    async () => {
      const boot = await bootIdentity();
      for (const name of ['createListSessionsRouter', 'createSessionRevokeRouter', 'createPanicRevokeRouter'] as const)
        expect(boot.calls(name), name).toEqual([[boot.sql]]);
      expect(boot.procedures).toEqual(expect.arrayContaining(['listSessions', 'revokeSession', 'panicRevoke']));
    },
    BOOT_TIMEOUT_MS,
  );

  it(
    'mergeRouters includes createApiKeyOriginRouter and createApiKeyProductRouter so bind/mint are live doors',
    async () => {
      const boot = await bootIdentity();
      expect(boot.calls('createApiKeyOriginRouter')).toEqual([[boot.sql, boot.auth, boot.auth]]);
      expect(boot.calls('createApiKeyProductRouter')).toEqual([[boot.sql, boot.auth, boot.auth]]);
      expect(boot.procedures).toEqual(expect.arrayContaining(['bindApiKeyOriginAllowlist', 'bindApiKeyProductScope']));
    },
    BOOT_TIMEOUT_MS,
  );

  it(
    'mergeRouters includes createActionApprovalRouter',
    async () => {
      const boot = await bootIdentity();
      expect(boot.calls('createActionApprovalRouter')).toHaveLength(1);
      expect((boot.calls('createActionApprovalRouter')[0]?.[0] as object | undefined)?.constructor.name).toBe('ActionApprovalService');
      expect(boot.procedures).toEqual(
        expect.arrayContaining(['actionApproval.propose', 'actionApproval.approve', 'actionApproval.consume']),
      );
    },
    BOOT_TIMEOUT_MS,
  );

  it('the door stamps through requireAttribution and attributedSurfaces: one stamp on order, fill and ledger', async () => {
    const app = await mountDoor(mockAuth());
    try {
      for (const named of [{ sessionId: SESSION }, { apiKeyId: 'key-1' }, { sessionId: SESSION, apiKeyId: 'key-1' }]) {
        const res = await app.inject({ method: 'POST', url: '/trpc/attribution.stamp', payload: named });
        expect(res.statusCode, JSON.stringify(named)).toBe(200);
        const body = res.json() as { result?: { data?: unknown } };
        expect(body.result?.data).toEqual(attributedSurfaces(requireAttribution(named)));
      }
      // Neither named is the shared refusal, by its code.
      const res = await app.inject({ method: 'POST', url: '/trpc/attribution.stamp', payload: {} });
      expect(res.statusCode).toBe(412);
      expect(JSON.stringify(res.json())).toContain(`[${ATTRIBUTION_MISSING}]`);
    } finally {
      await app.close();
    }
  });

  it('signed-out stamp is 412 attribution_missing — not empty, not degraded', async () => {
    const app = await mountDoor(mockAuth());
    try {
      const res = await app.inject({ method: 'POST', url: '/trpc/attribution.stamp', payload: {} });
      const body = res.json() as WireBody;
      expect(res.statusCode).toBe(412);
      expect(body.error?.data?.code).toBe('PRECONDITION_FAILED');
      expect(body.error?.message).toMatch(/session or API-key id/i);
      expect(JSON.stringify(body)).toContain(ATTRIBUTION_MISSING);
    } finally {
      await app.close();
    }
  });

  it('assert with neither session nor API-key id is 412 — signed-out ≠ empty stamp', async () => {
    const app = await mountDoor(mockAuth());
    try {
      const res = await app.inject({ method: 'POST', url: '/trpc/attribution.assert', payload: {} });
      expect(res.statusCode).toBe(412);
      const body = res.json() as WireBody;
      expect(body.error?.data?.code).toBe('PRECONDITION_FAILED');
      expect(body.error?.message).toMatch(/does not invent attribution/i);
    } finally {
      await app.close();
    }
  });

  it('exchange over the wire puts API-key id on order/fill/ledger', async () => {
    const app = await mountDoor(mockAuth());
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/trpc/attribution.exchange',
        payload: { key: 'ifc_live_attribution_key' },
      });
      expect(res.statusCode).toBe(200);
      const data = unwrapData(res.json() as WireBody) as {
        keyId: string;
        attribution: {
          order: { apiKeyId: string | null; sessionId: string | null };
          fill: { apiKeyId: string | null };
          ledger: { apiKeyId: string | null };
        };
      };
      expect(data.keyId).toBe(KEY_ID);
      expect(data.attribution.order.apiKeyId).toBe(KEY_ID);
      expect(data.attribution.fill.apiKeyId).toBe(KEY_ID);
      expect(data.attribution.ledger.apiKeyId).toBe(KEY_ID);
      expect(data.attribution.order.sessionId).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('mint over the wire puts session and API-key id on order/fill/ledger', async () => {
    const app = await mountDoor(mockAuth());
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/trpc/attribution.mint',
        headers: signedHeaders(),
        payload: { name: 'desk', scopes: ['trade:write'], factorProof: { proofId: '88888888-8888-4888-8888-888888888888' } },
      });
      expect(res.statusCode).toBe(200);
      const data = unwrapData(res.json() as WireBody) as {
        id: string;
        attribution: {
          order: { apiKeyId: string | null; sessionId: string | null };
          fill: { sessionId: string | null; apiKeyId: string | null };
          ledger: { sessionId: string | null; apiKeyId: string | null };
        };
      };
      expect(data.id).toBe(KEY_ID);
      expect(data.attribution.order.sessionId).toBe(SESSION);
      expect(data.attribution.order.apiKeyId).toBe(KEY_ID);
      expect(data.attribution.fill.sessionId).toBe(SESSION);
      expect(data.attribution.ledger.apiKeyId).toBe(KEY_ID);
    } finally {
      await app.close();
    }
  });

  it('assert over the wire returns a persistable API-key stamp', async () => {
    const app = await mountDoor(mockAuth());
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/trpc/attribution.assert',
        payload: { keyId: KEY_ID },
      });
      expect(res.statusCode).toBe(200);
      const data = unwrapData(res.json() as WireBody) as {
        id: string;
        attribution: { order: { apiKeyId: string | null } };
      };
      expect(data.id).toBe(KEY_ID);
      expect(data.attribution.order.apiKeyId).toBe(KEY_ID);
    } finally {
      await app.close();
    }
  });
});
