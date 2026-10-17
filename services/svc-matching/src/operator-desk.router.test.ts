import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { issueAccessToken, type Principal, type TokenConfig } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { MatchingEngine } from './engine/engine.js';
import { MemoryJournal } from './engine/journal.js';
import { registerRoutes } from './router.js';
import { stubApprovalConsumer, type ActionApprovalConsumer } from './action-approval-consume.js';

const SECRET = 'matching-operator-desk-secret-32ch';
const EDGE_SECRET = 'edge-principal-secret-at-least-32-characters';
const WRONG_SECRET = 'wrong-edge-principal-secret-32-characters-xx';
const REGION = 'XX';
const MARKET = 'BTC-USDT';
const OPERATOR = '11111111-1111-4111-8111-111111111111';
const CONFIRM = '44444444-4444-4444-8444-444444444444';
const tokens: TokenConfig = {
  secret: 'test-only-signing-secret-at-least-32-characters-long',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

function counting(inner: ActionApprovalConsumer) {
  let calls = 0;
  return {
    calls: () => calls,
    consume: async (input: Parameters<ActionApprovalConsumer['consume']>[0]) => {
      calls += 1;
      return inner.consume(input);
    },
  };
}

async function mount(options: { edgePrincipalSecret?: string; tokens?: TokenConfig; approvals?: ReturnType<typeof counting> } = {}) {
  const engine = new MatchingEngine({
    journal: new MemoryJournal(),
    bus: new MemoryEventBus('svc-matching'),
    snapshotEvery: 0,
  });
  const app = Fastify({ logger: false });
  // `tokens` stays on the bag so a regression that verifies the bearer again
  // (the f0b383c7d door) returns 200 and the refusal test fails. The live door
  // reads `edgePrincipalSecret` only.
  const routeOptions = {
    approvals: options.approvals ?? counting(stubApprovalConsumer(CONFIRM, OPERATOR)),
    operatorIds: new Set([OPERATOR, CONFIRM]),
    ...(options.tokens ? { tokens: options.tokens } : {}),
    ...(options.edgePrincipalSecret ? { edgePrincipalSecret: options.edgePrincipalSecret } : {}),
  };
  registerRoutes(app, engine, SECRET, routeOptions);
  await app.ready();
  return { app, engine };
}

function principalOf(scopes: string[], mfa: boolean): Principal {
  return {
    sub: OPERATOR,
    userId: OPERATOR,
    scopes,
    tier: 'institutional',
    mfa,
    sid: '22222222-2222-4222-8222-222222222222',
    expiresAt: new Date(Date.now() + 60_000),
  };
}

function edgeHeaders(scopes: string[], mfa: boolean, secret = EDGE_SECRET) {
  const raw = encodePrincipal(principalOf(scopes, mfa));
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, secret, REGION),
    'x-intafaced-region': REGION,
  };
}

async function bearer(scopes: string[], mfa: boolean) {
  const { token } = await issueAccessToken(
    { userId: OPERATOR, sessionId: '22222222-2222-4222-8222-222222222222', scopes, tier: 'institutional', mfa },
    tokens,
  );
  return `Bearer ${token}`;
}

function haltBody(over: Record<string, unknown> = {}) {
  return {
    marketId: MARKET,
    approvalId: 'appr-1',
    operationId: 'op-1',
    idempotencyKey: 'halt-key-01',
    ...over,
  };
}

async function close(app: FastifyInstance) {
  await app.close();
}

function matchingComposeBlock(): string {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
  const compose = readFileSync(join(root, 'docker-compose.apps.yml'), 'utf8');
  const start = compose.indexOf('\n  svc-matching:');
  expect(start, 'svc-matching service missing from docker-compose.apps.yml').toBeGreaterThanOrEqual(0);
  const rest = compose.slice(start + 1);
  const next = rest.search(/\n  svc-[a-z]+:/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('founder matching operator door', () => {
  it('refuses when the edge principal secret is unset and does not publish a book count', async () => {
    const { app } = await mount();
    const res = await app.inject({ method: 'GET', url: '/operator/in-flight' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'matching.operator_auth_unconfigured' });
    expect(JSON.stringify(res.json())).not.toContain('restingOrders');
    await close(app);
  });

  it('refuses a bearer JWT with admin:write and MFA when no edge principal is sent', async () => {
    const approvals = counting(stubApprovalConsumer(CONFIRM, OPERATOR));
    const { app, engine } = await mount({ tokens, edgePrincipalSecret: EDGE_SECRET, approvals });
    const res = await app.inject({
      method: 'POST',
      url: '/operator/halt',
      headers: { authorization: await bearer(['admin:write'], true) },
      payload: haltBody(),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'token.invalid' });
    expect(approvals.calls()).toBe(0);
    expect(engine.isHalted(MARKET)).toBe(false);
    await close(app);
  });

  it('reads the live engine for an edge-signed admin:read principal', async () => {
    const { app, engine } = await mount({ edgePrincipalSecret: EDGE_SECRET });
    expect(engine.isVenueHalted).toBe(false);
    expect(engine.restingOrderCount).toBe(0);
    const res = await app.inject({
      method: 'GET',
      url: '/operator/in-flight',
      headers: edgeHeaders(['admin:read'], false),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ venueHalted: false, restingOrders: 0, markets: [] });
    await close(app);
  });

  it('refuses halt without admin:write, and admin:write without MFA', async () => {
    const { app } = await mount({ edgePrincipalSecret: EDGE_SECRET });
    const read = await app.inject({
      method: 'POST',
      url: '/operator/halt',
      headers: edgeHeaders(['admin:read'], true),
      payload: haltBody(),
    });
    expect(read.statusCode).toBe(403);
    expect(read.json()).toMatchObject({ code: 'scope.denied' });
    const noMfa = await app.inject({
      method: 'POST',
      url: '/operator/halt',
      headers: edgeHeaders(['admin:write'], false),
      payload: haltBody(),
    });
    expect(noMfa.statusCode).toBe(401);
    expect(noMfa.json()).toMatchObject({ code: 'mfa.required' });
    await close(app);
  });

  it('halts from the principal user, ignores a typed operatorId, and replays without a second consume', async () => {
    const approvals = counting(stubApprovalConsumer(CONFIRM, OPERATOR));
    const { app, engine } = await mount({ edgePrincipalSecret: EDGE_SECRET, approvals });
    const headers = edgeHeaders(['admin:write'], true);
    const first = await app.inject({
      method: 'POST',
      url: '/operator/halt',
      headers,
      payload: haltBody({ operatorId: 'stranger' }),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ accepted: true, halted: true, marketId: MARKET, operatorId: OPERATOR });
    expect(engine.isHalted(MARKET)).toBe(true);
    const replay = await app.inject({ method: 'POST', url: '/operator/halt', headers, payload: haltBody() });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(approvals.calls()).toBe(1);
    const conflict = await app.inject({
      method: 'POST',
      url: '/operator/halt',
      headers,
      payload: haltBody({ marketId: 'ETH-USDT' }),
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'matching.idempotency_conflict' });
    expect(approvals.calls()).toBe(1);
    await close(app);
  });

  it('refuses a principal signed with the wrong secret and does not halt', async () => {
    const approvals = counting(stubApprovalConsumer(CONFIRM, OPERATOR));
    const { app, engine } = await mount({ tokens, edgePrincipalSecret: EDGE_SECRET, approvals });
    const res = await app.inject({
      method: 'POST',
      url: '/operator/halt',
      headers: {
        authorization: await bearer(['admin:write'], true),
        ...edgeHeaders(['admin:write'], true, WRONG_SECRET),
      },
      payload: haltBody(),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'token.invalid', rejected: 'bad-signature' });
    expect(approvals.calls()).toBe(0);
    expect(engine.isHalted(MARKET)).toBe(false);
    await close(app);
  });

  it('svc-matching compose does not hold JWT_ACCESS_SECRET and merges *edge-secret', () => {
    const block = matchingComposeBlock();
    expect(block).not.toContain('JWT_ACCESS_SECRET');
    expect(block).toContain('*edge-secret');
    expect(block).toMatch(/<<:\s*\[\*service-env,\s*\*internal-secret,\s*\*edge-secret\]/);
  });
});
