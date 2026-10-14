/**
 * usage.settle / usage.settleSession require HMAC as svc-agents.
 * Session-only admin:write is 401. Wrong HMAC caller (svc-trade) is 403.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { createAgentsRouter, type AgentsRouter } from './router.js';
import type { AgentsRouterDeps } from './router.js';
import { chargeKeyFor } from './metering/meter.js';
import type { SettlementResult } from './metering/meter.js';

const EDGE_SECRET = 'an-agents-settle-hmac-rest-edge-secret-32b';
const SERVICE_SECRET = 'a'.repeat(32);
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '33333333-3333-4333-8333-333333333333';
const WINDOW = '2026-08-12T10';
const DIR = dirname(fileURLToPath(import.meta.url));

type WireBody = {
  result?: { data?: { json?: unknown } };
  error?: { message?: string; data?: { code?: string; httpStatus?: number } };
};

function principal(scopes: string[]): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'none',
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

// Was v1 `serviceAuthHeaders(caller, secret)`: an unbound signature the tRPC door
// accepted only because it defaulted to accept-both. The door is `require` now
// and every real caller signs v2 over the exact body it sends.
function hmacHeaders(caller: 'svc-agents' | 'svc-trade', body: Record<string, unknown>): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...serviceAuthHeadersForBody(caller, SERVICE_SECRET, JSON.stringify(body)),
  };
}

const offSettle = (sessionId: string, windowId: string): SettlementResult => ({
  sessionId,
  windowId,
  chargeKey: chargeKeyFor(sessionId, windowId),
  amount: 0n,
  chargeTxId: null,
  settled: false,
});

const deps: AgentsRouterDeps = {
  runtime: {
    settleWindow: async (sessionId: string, windowId: string) => offSettle(sessionId, windowId),
    settleSession: async (sessionId: string) => [offSettle(sessionId, WINDOW)],
  } as AgentsRouterDeps['runtime'],
  gateway: { routingTable: { routes: [] } } as unknown as AgentsRouterDeps['gateway'],
  meter: {} as AgentsRouterDeps['meter'],
  feeAssetId: 'IFC',
};

const router = createAgentsRouter(deps);
const edgeContext = createEdgeContext({
  secret: EDGE_SECRET,
  serviceName: 'svc-agents',
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
    } satisfies FastifyTRPCPluginOptions<AgentsRouter>['trpcOptions'],
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

const settlePayload = { sessionId: SESSION, windowId: WINDOW };
const settleSessionPayload = { sessionId: SESSION };

describe('usage settle HMAC as svc-agents', () => {
  it('router settle doors are not session admin:write', () => {
    const src = readFileSync(join(DIR, 'router.ts'), 'utf8');
    expect(src).toMatch(/settleWriteProcedure/);
    expect(src).not.toMatch(/scopedProcedure\('admin:write'/);
    const index = readFileSync(join(DIR, 'index.ts'), 'utf8');
    expect(index).toMatch(/internalSecret/);
  });

  it.each([
    { name: 'settle', path: 'usage.settle', payload: settlePayload },
    { name: 'settleSession', path: 'usage.settleSession', payload: settleSessionPayload },
  ] as const)('$name unsigned → 401', async ({ path, payload }) => {
    const { statusCode, body } = await post(path, payload);
    expect(statusCode).toBe(401);
    expect(body.error?.data?.code).toBe('UNAUTHORIZED');
  });

  it.each([
    { name: 'settle', path: 'usage.settle', payload: settlePayload },
    { name: 'settleSession', path: 'usage.settleSession', payload: settleSessionPayload },
  ] as const)('$name session admin:write → 401', async ({ path, payload }) => {
    const { statusCode, body } = await post(path, payload, signedHeaders(['admin:write', 'agents:execute']));
    expect(statusCode).toBe(401);
    expect(body.error?.data?.code).toBe('UNAUTHORIZED');
    expect(body.error?.data?.code).not.toBe('FORBIDDEN');
  });

  it.each([
    { name: 'settle', path: 'usage.settle', payload: settlePayload },
    { name: 'settleSession', path: 'usage.settleSession', payload: settleSessionPayload },
  ] as const)('$name svc-trade HMAC → 403', async ({ path, payload }) => {
    const { statusCode, body } = await post(path, payload, hmacHeaders('svc-trade', payload));
    expect(statusCode).toBe(403);
    expect(body.error?.data?.code).toBe('FORBIDDEN');
  });

  it('usage.settle HMAC as svc-agents reaches the meter door', async () => {
    const { statusCode, body } = await post('usage.settle', settlePayload, hmacHeaders('svc-agents', settlePayload));
    expect(statusCode).toBe(200);
    expect(body.result?.data).toBeDefined();
  });

  it('usage.settleSession HMAC as svc-agents reaches the meter door', async () => {
    const { statusCode, body } = await post('usage.settleSession', settleSessionPayload, hmacHeaders('svc-agents', settleSessionPayload));
    expect(statusCode).toBe(200);
    expect(body.result?.data).toBeDefined();
  });
});
