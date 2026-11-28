/**
 * Job tRPC twins require HMAC as svc-token.
 * Session-only admin:treasury is 401. Wrong HMAC caller (svc-trade) is 403.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import type { Principal } from '@intafaced/auth';
import { TOKEN_DISTRIBUTE_REVENUE } from '@intafaced/contracts/token-distribute-revenue-procedures';
import { TOKEN_MINT_EPOCH } from '@intafaced/contracts/token-mint-epoch-procedures';
import { JOB_FORBIDDEN } from './job-hmac.js';
import { createEdgeContext, encodePrincipal, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { stubApprovalConsumer } from './action-approval-consume.js';
import { createTokenRouter, type TokenRouter } from './router.js';
import type { TokenService } from './token-service.js';

const EDGE_SECRET = 'a-token-job-hmac-rest-edge-secret-32';
const SERVICE_SECRET = 'a'.repeat(32);
const USER = '11111111-1111-4111-8111-111111111111';
const RUN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const WINDOW = { from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' };

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

function hmacHeaders(caller: 'svc-token' | 'svc-trade' | 'svc-cron', body: Record<string, unknown>): Record<string, string> {
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
  it('job doors are HMAC as svc-token, not admin:treasury; the treasury doors stay session admin:treasury with a second person', async () => {
    // mintEpoch and distributeRevenue mount their records, whose access the mount turns into these guards.
    expect(TOKEN_MINT_EPOCH.access).toEqual({ caller: 'service', callers: ['svc-token'], forbidden: JOB_FORBIDDEN });
    expect(TOKEN_DISTRIBUTE_REVENUE.access).toEqual({ caller: 'scope', scope: 'admin:treasury' });

    // A job door answers a session holding admin:treasury as unauthenticated: no session is a job caller.
    for (const { path, payload } of JOBS) {
      const { statusCode } = await post(path, payload, signedHeaders(['admin:treasury']));
      expect(statusCode, path).toBe(401);
    }

    // recordBuyback is a session door: an HMAC job caller is not a principal, and a session needs admin:treasury.
    const buyback = {
      runId: RUN,
      revenueWindow: WINDOW,
      revenueTotal: { IFC: '1000' },
      tokensBought: '100',
      approvalId: 'appr-1',
      operationId: 'op-1',
    };
    expect((await post('recordBuyback', buyback, hmacHeaders('svc-token', buyback))).statusCode).toBe(401);
    const noScope = await post('recordBuyback', buyback, signedHeaders(['token:read']));
    expect(noScope.statusCode).toBe(403);
    expect(noScope.body.error?.data?.code).toBe('FORBIDDEN');

    // With admin:treasury it still needs a second person: the same operator approving refuses, another passes.
    const asCaller = (approverId: string) =>
      createTokenRouter(token, { approvals: stubApprovalConsumer(approverId) }).createCaller(
        edgeContext({ headers: signedHeaders(['admin:treasury']), id: 'req-dual' } as never),
      );
    vi.mocked(token.recordBuyback).mockClear();
    await expect(asCaller(USER).recordBuyback(buyback)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'confirming operator must be a distinct identity; the token service does not invent a second caller',
    });
    expect(token.recordBuyback).not.toHaveBeenCalled();
    await expect(asCaller('dddddddd-dddd-4ddd-8ddd-dddddddddddd').recordBuyback(buyback)).resolves.toMatchObject({
      runId: RUN,
      confirmOperatorId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    });
    expect(token.recordBuyback).toHaveBeenCalledTimes(1);
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

  it.each(JOBS.flatMap((job) => (['svc-trade', 'svc-cron'] as const).map((caller) => ({ ...job, caller }))))(
    "$name $caller HMAC → 403 with the job door's own words",
    async ({ path, payload, caller }) => {
      const { statusCode, body } = await post(path, payload, hmacHeaders(caller, payload));
      expect(statusCode).toBe(403);
      expect(body.error?.data?.code).toBe('FORBIDDEN');
      expect(body.error?.message).toBe(JOB_FORBIDDEN);
    },
  );

  it.each(JOBS)('$name HMAC as svc-token reaches the job', async ({ path, payload }) => {
    const { statusCode, body } = await post(path, payload, hmacHeaders('svc-token', payload));
    expect(statusCode).toBe(200);
    expect(body.result?.data).toBeDefined();
  });
});
