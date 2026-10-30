/**
 * ops job tRPC twins require HMAC as svc-bank.
 * Session-only admin:treasury is 401. Wrong HMAC caller (svc-trade) is 403.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import type { Principal } from '@intafaced/auth';
import {
  createEdgeContext,
  encodePrincipal,
  rawBodyOf,
  retainRawBody,
  serviceAuthHeadersForBody,
  signPrincipalHeader,
  verifyServiceHeaders,
} from '@intafaced/contracts';
import { createBankRouter, type BankRouter } from './router.js';
import type { BankServices } from './bank-service.js';
import { bankRouterSource } from './router/router-source.js';

const EDGE_SECRET = 'a-bank-ops-job-hmac-rest-edge-secret-32';
const SERVICE_SECRET = 'a'.repeat(32);
const USER = '11111111-1111-4111-8111-111111111111';
const DIR = dirname(fileURLToPath(import.meta.url));

const JOBS = [
  { name: 'runDueTransfers', path: 'ops.runDueTransfers', payload: {} },
  { name: 'runAutoInvest', path: 'ops.runAutoInvest', payload: {} },
  { name: 'accrueInterest', path: 'ops.accrueInterest', payload: {} },
  { name: 'accrueLoanInterest', path: 'ops.accrueLoanInterest', payload: {} },
  { name: 'runRiskSweep', path: 'ops.runRiskSweep', payload: {} },
  { name: 'resumePendingLoans', path: 'ops.resumePendingLoans', payload: {} },
  { name: 'resumePendingEarn', path: 'ops.resumePendingEarn', payload: {} },
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

function hmacHeaders(caller: 'svc-bank' | 'svc-trade', body: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...serviceAuthHeadersForBody(caller, SERVICE_SECRET, body),
  };
}

const bank = {
  transfers: {
    runDueTransfers: async () => ({
      schedulesConsidered: 0,
      settled: 0,
      rejected: 0,
      alreadyFired: 0,
      strandedSwept: 0,
      failures: [],
    }),
  },
  autoInvest: {
    runDue: async () => ({ considered: 0, settled: 0, skipped: 0, rejected: 0, failures: [] }),
  },
  earn: {
    accrueAll: async () => ({ results: [], failures: [] }),
    resumePending: async () => [],
  },
  loans: {
    originationFeeBps: '0',
    accrueAll: async () => ({ results: [], failures: [] }),
    runRiskSweep: async () => ({ marked: 0, called: 0, liquidated: 0, cleared: 0, refused: [] }),
    resumePending: async () => [],
  },
} as unknown as BankServices;

const router = createBankRouter(bank);
const edgeContext = createEdgeContext({
  secret: EDGE_SECRET,
  serviceName: 'svc-bank',
  internalSecret: SERVICE_SECRET,
});

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router,
      createContext: ({ req }) => {
        const ctx = edgeContext(req);
        const rawBody = typeof req.body === 'string' ? { retained: true as const, bytes: Buffer.from(req.body, 'utf8') } : rawBodyOf(req);
        const { service } = verifyServiceHeaders(req.headers, SERVICE_SECRET, {
          rawBody,
          mode: 'require',
        });
        return { ...ctx, service };
      },
    } satisfies FastifyTRPCPluginOptions<BankRouter>['trpcOptions'],
  });
  retainRawBody(app);
  await app.ready();
}, 20_000);

afterAll(async () => {
  await app.close();
});

async function post(
  path: string,
  payload: Record<string, unknown>,
  headers?: Record<string, string> | ((body: string) => Record<string, string>),
): Promise<{ statusCode: number; body: WireBody }> {
  const body = JSON.stringify(payload);
  const resolved = typeof headers === 'function' ? headers(body) : headers;
  const res = await app.inject({
    method: 'POST',
    url: `/trpc/${path}`,
    headers: { 'content-type': 'application/json', ...resolved },
    payload: body,
  });
  return { statusCode: res.statusCode, body: res.json() as WireBody };
}

describe('ops job tRPC HMAC as svc-bank (HTTP)', () => {
  it('job doors are HMAC as svc-bank, not admin:treasury; index verifies service headers', () => {
    const src = bankRouterSource();
    expect(src).toMatch(/jobProcedure/);
    expect(src).toMatch(/requireBankJobService/);
    for (const job of JOBS) {
      expect(src).toMatch(new RegExp(`${job.name}: jobProcedure`));
    }
    expect(src).toMatch(/seizeLoan: scopedProcedure\('admin:treasury'/);
    expect(src).toMatch(/fundPool: scopedProcedure\('admin:treasury'/);
    const index = readFileSync(join(DIR, 'index.ts'), 'utf8');
    expect(index).toMatch(/internalSecret/);
    expect(index).toMatch(/retainRawBody\(app\)/);
    expect(index).toMatch(/inboundRawBody\(req\)/);
    expect(index).toMatch(/bodyBindMode:\s*env\.INTERNAL_SERVICE_BODY_BIND/);
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
    const { statusCode, body } = await post(path, payload, (bytes) => hmacHeaders('svc-trade', bytes));
    expect(statusCode).toBe(403);
    expect(body.error?.data?.code).toBe('FORBIDDEN');
  });

  it.each(JOBS)('$name HMAC as svc-bank reaches the job', async ({ path, payload }) => {
    const { statusCode, body } = await post(path, payload, (bytes) => hmacHeaders('svc-bank', bytes));
    expect(statusCode).toBe(200);
    expect(body.result?.data).toBeDefined();
  });
});
