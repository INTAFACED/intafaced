/**
 * Unit card (D32):
 * Promise: OMS execute + EMS journal refuse invent through mounted Fastify+tRPC
 *   public doors (OMS execute HMAC as svc-execution; EMS reads edge-signed) — not createCaller-only guards.
 * Break: execute could pretend success without venue submit; ems.get/list could
 *   return empty acks when the journal store is unwired.
 * Done bar:
 *   · execution.oms.execute without the EMS journal → ok:false / ems_store_unwired.
 *   · execution.oms.ems.get + list without EMS store → PRECONDITION_FAILED.
 * Class: N (honesty). Leverage: createExecutionRouter + Fastify TRPC mount.
 */
import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import { latencyGradeWire } from './oms-plan.js';
import { createExecutionRouter } from './router.js';

const EDGE_SECRET = 'execution-promise-falsify-public-doors-edge-secret-32';
const SERVICE_SECRET = 'a'.repeat(32);
const OP = '33333333-3333-4333-8333-333333333333';

const edgeContext = createEdgeContext({
  secret: EDGE_SECRET,
  serviceName: 'svc-execution',
  internalSecret: SERVICE_SECRET,
});

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: OP,
    userId: OP,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['admin:read', 'admin:write'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signedHeaders(p: Principal = principal()): Record<string, string> {
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

function hmacHeaders(body: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...serviceAuthHeadersForBody('svc-execution', SERVICE_SECRET, body),
  };
}

const venueBody = {
  id: 'street',
  kind: 'external-cex' as const,
  price: '100',
  amount: '10',
  feeBps: 10,
  costTerms: {
    feeBps: 10,
    expectedImpactBps: 5,
    transferCostBps: 2,
    latencyGrade: latencyGradeWire('street'),
  },
};

async function mountRouter(router = createExecutionRouter(new SealedHouseTenantRegistry())): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, maxParamLength: 5_000 });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router,
      createContext: ({ req }) => edgeContext({ headers: req.headers, id: req.id }),
    } satisfies FastifyTRPCPluginOptions<typeof router>['trpcOptions'],
  });
  await app.ready();
  return app;
}

type TrpcBody = {
  result?: { data?: unknown };
  error?: { message?: string; data?: { code?: string; httpStatus?: number } };
};

async function trpcQuery(app: FastifyInstance, path: string, input: unknown, headers = signedHeaders()) {
  const url = `/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.inject({ method: 'GET', url, headers });
  return { status: res.statusCode, body: JSON.parse(res.payload) as TrpcBody };
}

async function trpcMutation(app: FastifyInstance, path: string, input: unknown, extraHeaders?: Record<string, string>) {
  const body = JSON.stringify(input);
  const res = await app.inject({
    method: 'POST',
    url: `/trpc/${path}`,
    headers: { 'content-type': 'application/json', ...(extraHeaders ?? signedHeaders()) },
    payload: body,
  });
  return { status: res.statusCode, body: JSON.parse(res.payload) as TrpcBody };
}

describe('execution promise-falsify public doors (D32)', () => {
  it('mounted EMS read refuses an unconfigured screening list', async () => {
    const keys = ['INTAFACED_SCREENING_FAIL_CLOSED', 'INTAFACED_SANCTIONS_REGIONS', 'INTAFACED_SANCTIONS_SOURCE'] as const;
    const prior = keys.map((key) => process.env[key]);
    const app = await mountRouter();
    try {
      process.env.INTAFACED_SCREENING_FAIL_CLOSED = 'on';
      delete process.env.INTAFACED_SANCTIONS_REGIONS;
      delete process.env.INTAFACED_SANCTIONS_SOURCE;
      const out = await trpcQuery(app, 'execution.oms.ems.get', { clientOrderId: 'missing' });
      expect(out.status).toBe(403);
      expect(out.body.error?.data?.code).toBe('FORBIDDEN');
      expect(out.body.error?.message).toMatch(/screening list is unset/i);
    } finally {
      keys.forEach((key, index) => {
        if (prior[index] === undefined) delete process.env[key];
        else process.env[key] = prior[index];
      });
      await app.close();
    }
  });
  it('oms.execute refuses submit_failed when venue submit is not wired', async () => {
    const app = await mountRouter();
    const input = {
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: '1',
      parentClientOrderId: 'promise-parent',
      venues: [venueBody],
    };
    const out = await trpcMutation(app, 'execution.oms.execute', input, hmacHeaders(JSON.stringify(input)));
    expect(out.body.result?.data).toMatchObject({ ok: false, reason: 'ems_store_unwired' });
    await app.close();
  });

  it('oms.ems.get refuses PRECONDITION_FAILED when EMS store is unwired', async () => {
    const app = await mountRouter();
    const out = await trpcQuery(app, 'execution.oms.ems.get', { clientOrderId: 'missing' });
    expect(out.body.error?.data?.code).toBe('PRECONDITION_FAILED');
    expect(out.body.error?.message).toMatch(/EMS store is not wired/i);
    await app.close();
  });

  it('oms.ems.list refuses PRECONDITION_FAILED when EMS store is unwired', async () => {
    const app = await mountRouter();
    const out = await trpcQuery(app, 'execution.oms.ems.list', { venueId: 'street' });
    expect(out.body.error?.data?.code).toBe('PRECONDITION_FAILED');
    expect(out.body.error?.message).toMatch(/EMS store is not wired/i);
    await app.close();
  });

  it('anonymous ems.get is UNAUTHORIZED before EMS precondition is evaluated', async () => {
    const app = await mountRouter();
    const out = await trpcQuery(app, 'execution.oms.ems.get', { clientOrderId: 'x' }, { 'x-intafaced-region': 'DE' });
    expect(out.body.error?.data?.code).toBe('UNAUTHORIZED');
    await app.close();
  });
});
