/**
 * UNAUTHORIZED (no identity) ≠ FORBIDDEN (known, not allowed) on the mounted
 * wire. Blank HMAC is missing identity, not a scope miss.
 *
 * Doors: public kyc.submit, order-like subAccounts.assertOwned + rank perks
 * S2S (trade place/accept), admin kyc.approve.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import type { Principal } from '@intafaced/auth';
import {
  SERVICE_HEADER,
  SERVICE_SIGNATURE_HEADER,
  SERVICE_TIMESTAMP_HEADER,
  createEdgeContext,
  encodePrincipal,
  rawBodyOf,
  retainRawBody,
  signPrincipalHeader,
  verifyServiceHeaders,
} from '@intafaced/contracts';
import type { AuthService } from './auth/auth-service.js';
import type { RankService } from './rank/rank-service.js';
import { createIdentityRouter } from './router.js';

const EDGE_SECRET = 'identity-401-vs-403-public-doors-edge-secret-32';
const INTERNAL_SECRET = 'identity-401-vs-403-public-doors-internal-32';
const USER = '11111111-1111-4111-8111-111111111111';
const RECORD = '33333333-3333-4333-8333-333333333333';
const SUB = '55555555-5555-4555-8555-555555555555';
const here = dirname(fileURLToPath(import.meta.url));

type WireBody = {
  error?: { message?: string; data?: { code?: string; httpStatus?: number } };
};

function principal(scopes: string[]): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '44444444-4444-4444-8444-444444444444',
    scopes,
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

function signedHeaders(scopes: string[]): Record<string, string> {
  const raw = encodePrincipal(principal(scopes));
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

/** Principal bytes present, HMAC absent — must not look like a scope miss. */
function blankHmacHeaders(scopes: string[]): Record<string, string> {
  return {
    'x-intafaced-principal': encodePrincipal(principal(scopes)),
    'x-intafaced-principal-sig': '',
    'x-intafaced-region': 'DE',
  };
}

function blankServiceHmac(): Record<string, string> {
  return {
    [SERVICE_HEADER]: 'svc-trade',
    [SERVICE_TIMESTAMP_HEADER]: String(Math.floor(Date.now() / 1000)),
    [SERVICE_SIGNATURE_HEADER]: '',
  };
}

const auth = {
  async submitKyc() {
    throw new Error('submitKyc must not run');
  },
  async approveKycRecord() {
    throw new Error('approveKycRecord must not run');
  },
  async assertSubAccountOwned() {
    throw new Error('assertSubAccountOwned must not run');
  },
  async getSubAccountOwnership() {
    throw new Error('getSubAccountOwnership must not run');
  },
} as unknown as AuthService;

const rank = {
  async perks() {
    throw new Error('rank.perks must not run');
  },
} as unknown as RankService;

let app: FastifyInstance;

beforeAll(async () => {
  const router = createIdentityRouter(auth, rank, { registrationOpen: true });
  app = Fastify({ logger: false });
  retainRawBody(app);
  const edgeContext = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-identity' });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router,
      createContext: ({ req }) => edgeContext(req),
    } satisfies FastifyTRPCPluginOptions<typeof router>['trpcOptions'],
  });
  app.get<{ Params: { userId: string } }>('/internal/rank/:userId/perks', async (req, reply) => {
    if (
      verifyServiceHeaders(req.headers, INTERNAL_SECRET, {
        rawBody: rawBodyOf(req),
        mode: 'accept-both',
      }).service === null
    ) {
      return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
    }
    return rank.perks(req.params.userId);
  });
  await app.ready();
}, 20_000);

afterAll(async () => {
  await app.close();
});

async function post(
  path: string,
  payload: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<{ statusCode: number; body: WireBody }> {
  const res = await app.inject({ method: 'POST', url: `/trpc/${path}`, headers, payload });
  return { statusCode: res.statusCode, body: res.json() as WireBody };
}

const publicSubmit = { tier: 'basic', jurisdiction: 'DE' };
const orderAssert = { subAccountId: SUB };
const adminApprove = { recordId: RECORD };

const trpcDoors = [
  { name: 'public', path: 'kyc.submit', payload: publicSubmit, badScope: ['identity:read'] as const },
  { name: 'order-like', path: 'subAccounts.assertOwned', payload: orderAssert, badScope: ['identity:read'] as const },
  { name: 'admin', path: 'kyc.approve', payload: adminApprove, badScope: ['identity:write'] as const },
] as const;

describe('401 vs 403 on public / order-like / admin doors', () => {
  it('index.ts S2S order-like doors refuse missing HMAC as 401, not a scope miss', () => {
    const src = readFileSync(join(here, 'index.ts'), 'utf8');
    for (const path of ['/internal/rank/:userId/perks', '/internal/sub-accounts/:subAccountId']) {
      const start = src.indexOf(path);
      expect(start, path).toBeGreaterThanOrEqual(0);
      const block = src.slice(start, start + 700);
      expect(block).toMatch(/serviceOfRequest/);
      expect(block).toMatch(/reply\.code\(401\)/);
      expect(block).toMatch(/identity\.unauthenticated/);
      expect(block).not.toMatch(/reply\.code\(403\)/);
    }
  });

  it.each(trpcDoors)('$name $path: missing creds → 401 UNAUTHORIZED', async ({ path, payload }) => {
    const { statusCode, body } = await post(path, payload);
    expect(statusCode).toBe(401);
    expect(body.error?.data?.code).toBe('UNAUTHORIZED');
    expect(body.error?.message).toMatch(/Authentication required/i);
  });

  it.each(trpcDoors)('$name $path: blank HMAC → 401, not FORBIDDEN', async ({ path, payload, badScope }) => {
    const claimed = [...badScope, 'admin:compliance', 'identity:write'];
    const { statusCode, body } = await post(path, payload, blankHmacHeaders(claimed));
    expect(statusCode).toBe(401);
    expect(body.error?.data?.code).toBe('UNAUTHORIZED');
    expect(body.error?.data?.code).not.toBe('FORBIDDEN');
    expect(body.error?.message ?? '').not.toMatch(/scope/i);
  });

  it.each(trpcDoors)('$name $path: signed bad scope → 403 FORBIDDEN', async ({ path, payload, badScope }) => {
    const { statusCode, body } = await post(path, payload, signedHeaders([...badScope]));
    expect(statusCode).toBe(403);
    expect(body.error?.data?.code).toBe('FORBIDDEN');
    expect(body.error?.message).toMatch(/scope/i);
  });

  it('order-like GET /internal/rank/:userId/perks: missing creds → 401', async () => {
    const res = await app.inject({ method: 'GET', url: `/internal/rank/${USER}/perks` });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'identity.unauthenticated' });
  });

  it('order-like GET /internal/rank/:userId/perks: blank HMAC → 401, not 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/internal/rank/${USER}/perks`,
      headers: blankServiceHmac(),
    });
    expect(res.statusCode).toBe(401);
    expect(res.statusCode).not.toBe(403);
    expect(res.json()).toMatchObject({ code: 'identity.unauthenticated' });
  });
});
