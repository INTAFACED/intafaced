/**
 * R-auth leftover (PTX-M01-R05): API-key mint / exchange / assert must produce
 * a session-or-key stamp a caller can persist onto order/fill/ledger.
 * Unit helpers alone are not a door. Signed-out is attribution_missing, not empty.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { AuthService } from './auth-service.js';
import { createApiKeyAttributionRouter } from '../api-key-attribution-router.js';
import { ATTRIBUTION_MISSING, installApiKeyAttribution } from './four-eyes.js';

const EDGE_SECRET = 'identity-api-key-attribution-public-door-secret-32';
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '44444444-4444-4444-8444-444444444444';
const KEY_ID = '55555555-5555-4555-8555-555555555555';
const here = dirname(fileURLToPath(import.meta.url));

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
    async acceptFreshFactor() {
      return 'totp' as const;
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
  it('boot path hitches AuthService and mounts the live door', () => {
    const indexSrc = readFileSync(join(here, '../index.ts'), 'utf8');
    expect(indexSrc).toMatch(/installApiKeyAttribution\(auth\)/);
    expect(indexSrc).toMatch(/createApiKeyAttributionRouter\(auth\)/);
    const door = readFileSync(join(here, '../api-key-attribution-router.ts'), 'utf8');
    expect(door).toMatch(/attribution_missing|ATTRIBUTION_MISSING/);
    expect(door).toMatch(/requireAttribution/);
    expect(door).toMatch(/attributedSurfaces/);
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
        payload: { name: 'desk', scopes: ['trade:write'], factorProof: { totpCode: '123456' } },
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
