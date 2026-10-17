import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { MemoryEventBus } from '@intafaced/events';
import { MatchingEngine } from './engine/engine.js';
import { MemoryJournal } from './engine/journal.js';
import { registerRoutes } from './router.js';
import { stubApprovalConsumer, type ActionApprovalConsumer } from './action-approval-consume.js';

const SECRET = 'matching-operator-desk-secret-32ch';
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

async function mount(options: { tokens?: TokenConfig; approvals?: ReturnType<typeof counting> } = {}) {
  const engine = new MatchingEngine({
    journal: new MemoryJournal(),
    bus: new MemoryEventBus('svc-matching'),
    snapshotEvery: 0,
  });
  const app = Fastify({ logger: false });
  registerRoutes(app, engine, SECRET, {
    approvals: options.approvals ?? counting(stubApprovalConsumer(CONFIRM, OPERATOR)),
    operatorIds: new Set([OPERATOR, CONFIRM]),
    ...(options.tokens ? { tokens: options.tokens } : {}),
  });
  await app.ready();
  return { app, engine };
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

describe('founder matching operator door', () => {
  it('refuses when JWT is unset and does not publish a book count', async () => {
    const { app } = await mount();
    const res = await app.inject({ method: 'GET', url: '/operator/in-flight' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'matching.operator_auth_unconfigured' });
    expect(JSON.stringify(res.json())).not.toContain('restingOrders');
    await close(app);
  });

  it('reads the live engine for an admin:read session', async () => {
    const { app, engine } = await mount({ tokens });
    expect(engine.isVenueHalted).toBe(false);
    expect(engine.restingOrderCount).toBe(0);
    const res = await app.inject({
      method: 'GET',
      url: '/operator/in-flight',
      headers: { authorization: await bearer(['admin:read'], false) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ venueHalted: false, restingOrders: 0, markets: [] });
    await close(app);
  });

  it('refuses halt without admin:write, and admin:write without MFA', async () => {
    const { app } = await mount({ tokens });
    const read = await app.inject({
      method: 'POST',
      url: '/operator/halt',
      headers: { authorization: await bearer(['admin:read'], true) },
      payload: haltBody(),
    });
    expect(read.statusCode).toBe(403);
    expect(read.json()).toMatchObject({ code: 'scope.denied' });
    const noMfa = await app.inject({
      method: 'POST',
      url: '/operator/halt',
      headers: { authorization: await bearer(['admin:write'], false) },
      payload: haltBody(),
    });
    expect(noMfa.statusCode).toBe(401);
    expect(noMfa.json()).toMatchObject({ code: 'mfa.required' });
    await close(app);
  });

  it('halts from the token user, ignores a typed operatorId, and replays without a second consume', async () => {
    const approvals = counting(stubApprovalConsumer(CONFIRM, OPERATOR));
    const { app, engine } = await mount({ tokens, approvals });
    const headers = { authorization: await bearer(['admin:write'], true) };
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
});
