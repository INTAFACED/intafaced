/**
 * Job tRPC twins require HMAC as svc-token.
 * Session-only admin:treasury is 401. Wrong HMAC caller (svc-trade) is 403.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { createTokenRouter, type TokenRouter } from './router.js';
import type { TokenService } from './token-service.js';

const EDGE_SECRET = 'a-token-job-hmac-rest-edge-secret-32';
const SERVICE_SECRET = 'a'.repeat(32);
const USER = '11111111-1111-4111-8111-111111111111';
const RUN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const WINDOW = { from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' };
const DIR = dirname(fileURLToPath(import.meta.url));

const JOBS = [
  { name: 'mintEpoch', path: 'mintEpoch', payload: {} },
  {
    name: 'buyback.runWindow',
    path: 'buyback.runWindow',
    payload: { runId: RUN, revenueWindow: WINDOW },
  },
  { name: 'yield.runWindow', path: 'yield.runWindow', payload: { windowId: 'w1' } },
] as const;

type WireBody = {
  result?: { data?: unknown };
  error?: { message?: string; data?: { code?: string; httpStatus?: number } };
};

function principal(scopes: string[]): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
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
    'content-type': 'application/json',
  };
}

function hmacHeaders(caller: 'svc-token' | 'svc-trade', body: Record<string, unknown>): Record<string, string> {
  const payload = JSON.stringify(body);
  return {
    'content-type': 'application/json',
    ...serviceAuthHeadersForBody(caller, SERVICE_SECRET, payload),
  };
}

const token = {
  mintEpoch: vi.fn(async (epoch: number) => ({ epoch, minted: amt('68000') })),
  mintNextEpoch: vi.fn(async () => ({ epoch: 0, minted: amt('136000') })),
  distributeRevenue: vi.fn(async () => ({
    windowId: 'w1',
    distributed: amt('100'),
    recipients: 1,
    skipped: 0,
    alreadyPaid: 0,
  })),
  recordBuyback: vi.fn(async () => ({
    runId: RUN,
    burned: amt('50'),
    toRewards: amt('50'),
  })),
} as unknown as TokenService;

const router = createTokenRouter(token, {
  runYieldWindow: async () => ({
    windowId: 'w1',
    distributed: amt('55'),
    recipients: 1,
    skipped: 0,
    alreadyPaid: 0,
  }),
  runBuybackWindow: async () => ({
    runId: RUN,
    tokensBought: amt('10'),
    burned: amt('6'),
    toRewards: amt('4'),
  }),
});

const edgeContext = createEdgeContext({
  secret: EDGE_SECRET,
  serviceName: 'svc-token',
  internalSecret: SERVICE_SECRET,
});

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router,
      createContext: ({ req }) => edgeContext(req),
    } satisfies FastifyTRPCPluginOptions<TokenRouter>['trpcOptions'],
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
  const raw = JSON.stringify(payload);
  const res = await app.inject({
    method: 'POST',
    url: `/trpc/${path}`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: raw,
  });
  return { statusCode: res.statusCode, body: res.json() as WireBody };
}

describe('token job tRPC HMAC as svc-token (HTTP)', () => {
  it('job doors are HMAC as svc-token, not admin:treasury; index verifies service headers', () => {
    const src = readFileSync(join(DIR, 'router.ts'), 'utf8');
    expect(src).toMatch(/jobProcedure/);
    expect(src).toMatch(/requireTokenJobService/);
    expect(src).toMatch(/mintEpoch: jobProcedure/);
    expect(src).toMatch(/runWindow: jobProcedure/);
    expect(src).toMatch(/distributeRevenue: scopedProcedure\('admin:treasury'/);
    expect(src).toMatch(/recordBuyback: scopedProcedure\('admin:treasury'/);
    expect(src).toMatch(/requireDualControl/);
    const index = readFileSync(join(DIR, 'index.ts'), 'utf8');
    expect(index).toMatch(/internalSecret/);
    expect(index).toMatch(/retainRawBody\(app\)/);
    expect(index).toMatch(/INTERNAL_SERVICE_BODY_BIND/);
  });

  it.each(JOBS)('$name unsigned → 401', async ({ path, payload }) => {
    const { statusCode, body } = await post(path, payload);
    expect(statusCode).toBe(401);
    expect(body.error?.data?.code).toBe('UNAUTHORIZED');
  });

  it.each(JOBS)('$name session admin:treasury → 401', async ({ path, payload }) => {
    const { statusCode, body } = await post(path, payload, signedHeaders(['admin:treasury']));
    expect(statusCode).toBe(401);
    expect(body.error?.data?.code).toBe('UNAUTHORIZED');
    expect(body.error?.data?.code).not.toBe('FORBIDDEN');
  });

  it.each(JOBS)('$name svc-trade HMAC → 403', async ({ path, payload }) => {
    const { statusCode, body } = await post(path, payload, hmacHeaders('svc-trade', payload));
    expect(statusCode).toBe(403);
    expect(body.error?.data?.code).toBe('FORBIDDEN');
  });

  it.each(JOBS)('$name HMAC as svc-token reaches the job', async ({ path, payload }) => {
    const { statusCode, body } = await post(path, payload, hmacHeaders('svc-token', payload));
    expect(statusCode).toBe(200);
    expect(body.result?.data).toBeDefined();
  });
});
