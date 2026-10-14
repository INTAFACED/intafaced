import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { createMarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import { MatchingEngine } from './engine/engine.js';
import { MemoryJournal } from './engine/journal.js';
import { MARKET_HALTED, MISSING_OPERATOR } from './engine/halt.js';
import { registerRoutes } from './router.js';
import { stubApprovalConsumer } from './action-approval-consume.js';

/**
 * HTTP door for operator halt of one market.
 * Dual-control: operatorId + distinct confirmOperatorId. Missing/same confirm refuses.
 * New submits refuse. Cancels stay. Resume is a second door.
 */

const SECRET = 'matching-halt-router-secret-32chars!!';
const MARKET = 'BTC-USDT';
const OTHER = 'ETH-USDT';

function proofFor(marketId: string) {
  const observedAt = '2026-08-25T16:00:00.000Z';
  return createMarketLifecycleAdmissionProof(
    {
      marketId,
      ruleVersion: 'test.rules.v1',
      instrumentId: marketId,
      instrumentVersion: 'test.instrument.v1',
      state: 'OPEN',
      reasonCategory: 'NORMAL',
      reasonCode: 'trade.lifecycle.ready',
      effectiveAt: observedAt,
      observedAt,
      lastGoodState: 'OPEN',
      allowedActions: ['PLACE', 'PLACE_POST_ONLY'],
      transitionId: 'test.transition',
      evidenceRefs: ['test.evidence'],
    },
    'PLACE',
  );
}

function submitBody(marketId: string, over: Record<string, unknown> = {}) {
  return {
    orderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    accountId: 'desk',
    type: 'limit' as const,
    side: 'sell' as const,
    qty: '1',
    price: '100',
    tif: 'GTC' as const,
    lifecycleProof: proofFor(marketId),
    ...over,
  };
}

async function mount(): Promise<{ app: FastifyInstance; engine: MatchingEngine }> {
  const engine = new MatchingEngine({
    journal: new MemoryJournal(),
    bus: new MemoryEventBus('svc-matching'),
    snapshotEvery: 0,
  });
  const app = Fastify({ logger: false });
  registerRoutes(app, engine, SECRET, {
    bodyBind: 'require',
    approvals: stubApprovalConsumer('ops-confirm'),
    operatorIds: new Set(['ops-1', 'ops-confirm']),
  });
  await app.ready();
  return { app, engine };
}

function post(app: FastifyInstance, url: string, payloadBody: unknown) {
  const payload = JSON.stringify(payloadBody);
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-trade', SECRET, payload) },
    payload,
  });
}

function del(app: FastifyInstance, url: string) {
  const payload = '';
  return app.inject({
    method: 'DELETE',
    url,
    headers: { ...serviceAuthHeadersForBody('svc-trade', SECRET, payload) },
  });
}

describe('POST /markets/:marketId/halt', () => {
  it('HTTP halt without confirm refuses — no invented second operator', async () => {
    const { app, engine } = await mount();
    const rest = await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '11111111-1111-4111-8111-111111111111' }));
    expect(rest.statusCode).toBe(200);
    expect(rest.json().accepted).toBe(true);

    const halt = await post(app, `/markets/${MARKET}/halt`, { operatorId: 'ops-1' });
    expect(halt.statusCode).toBe(400);
    expect(halt.json().code).toBe('action_approval.missing');
    expect(engine.isHalted(MARKET)).toBe(false);

    const still = await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '22222222-2222-4222-8222-222222222222' }));
    expect(still.statusCode).toBe(200);
    expect(still.json().accepted).toBe(true);
    await app.close();
  });

  it('same-operator confirm refuses — no invented second caller', async () => {
    const { app, engine } = await mount();
    const halt = await post(app, `/markets/${MARKET}/halt`, { operatorId: 'ops-1', confirmOperatorId: 'ops-1' });
    expect(halt.statusCode).toBe(400);
    expect(halt.json().code).toBe('action_approval.missing');
    expect(engine.isHalted(MARKET)).toBe(false);
    await app.close();
  });

  it('halts one market so new submits refuse and another market still takes', async () => {
    const { app } = await mount();
    const rest = await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '11111111-1111-4111-8111-111111111111' }));
    expect(rest.statusCode).toBe(200);
    expect(rest.json().accepted).toBe(true);

    const halt = await post(app, `/markets/${MARKET}/halt`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    expect(halt.statusCode).toBe(200);
    expect(halt.json()).toMatchObject({
      accepted: true,
      marketId: MARKET,
      halted: true,
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-confirm',
      rejected: null,
    });
    expect(halt.json()).not.toHaveProperty('duration');
    expect(halt.json()).not.toHaveProperty('slo');

    const refused = await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '22222222-2222-4222-8222-222222222222' }));
    expect(refused.statusCode).toBe(200);
    expect(refused.json().accepted).toBe(false);
    expect(refused.json().rejected.code).toBe(MARKET_HALTED);

    const other = await post(app, `/markets/${OTHER}/orders`, submitBody(OTHER, { orderId: '33333333-3333-4333-8333-333333333333' }));
    expect(other.statusCode).toBe(200);
    expect(other.json().accepted).toBe(true);
    await app.close();
  });

  it('still cancels on a halted market', async () => {
    const { app } = await mount();
    await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '11111111-1111-4111-8111-111111111111' }));
    await post(app, `/markets/${MARKET}/halt`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });

    const cancelled = await del(app, `/markets/${MARKET}/orders/11111111-1111-4111-8111-111111111111`);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().cancelled).toBe(true);
    await app.close();
  });

  it('GET depth and GET /markets name halt so a public ladder cannot look tradable', async () => {
    const { app } = await mount();
    await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '11111111-1111-4111-8111-111111111111' }));
    await post(app, `/markets/${MARKET}/halt`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });

    const depth = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth?limit=50` });
    expect(depth.statusCode).toBe(200);
    expect(depth.json()).toMatchObject({
      marketId: MARKET,
      halted: true,
      prelaunch: false,
      expired: false,
      delisted: false,
      venueHalted: false,
    });

    const listed = await app.inject({ method: 'GET', url: '/markets' });
    expect(listed.json()).toMatchObject({
      venueHalted: false,
      halted: [MARKET],
      prelaunch: [],
      expired: [],
      delisted: [],
    });
    await app.close();
  });

  it('GET depth and GET /markets name reduce-only and post-only, and leave a market in neither mode off both', async () => {
    const { app } = await mount();
    const open = 'SOL-USDT';
    await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '11111111-1111-4111-8111-111111111111' }));
    await post(app, `/markets/${OTHER}/orders`, submitBody(OTHER, { orderId: '22222222-2222-4222-8222-222222222222' }));
    await post(app, `/markets/${open}/orders`, submitBody(open, { orderId: '33333333-3333-4333-8333-333333333333' }));

    const reduce = await post(app, `/markets/${MARKET}/reduce-only`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    expect(reduce.statusCode).toBe(200);
    expect(reduce.json().accepted).toBe(true);

    const postOnly = await post(app, `/markets/${OTHER}/post-only`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-2',
      operationId: 'op-2',
    });
    expect(postOnly.statusCode).toBe(200);
    expect(postOnly.json().accepted).toBe(true);

    const reduceDepth = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth?limit=50` });
    expect(reduceDepth.statusCode).toBe(200);
    expect(reduceDepth.json()).toMatchObject({
      marketId: MARKET,
      reduceOnly: true,
      postOnly: false,
      halted: false,
      prelaunch: false,
      expired: false,
      delisted: false,
      venueHalted: false,
    });
    const reduceL3 = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth/l3?limit=50` });
    expect(reduceL3.statusCode).toBe(200);
    expect(reduceL3.json()).toMatchObject({ marketId: MARKET, reduceOnly: true, postOnly: false });

    const postDepth = await app.inject({ method: 'GET', url: `/markets/${OTHER}/depth?limit=50` });
    expect(postDepth.statusCode).toBe(200);
    expect(postDepth.json()).toMatchObject({
      marketId: OTHER,
      reduceOnly: false,
      postOnly: true,
      halted: false,
      venueHalted: false,
    });
    const postL3 = await app.inject({ method: 'GET', url: `/markets/${OTHER}/depth/l3?limit=50` });
    expect(postL3.statusCode).toBe(200);
    expect(postL3.json()).toMatchObject({ marketId: OTHER, reduceOnly: false, postOnly: true });

    const openDepth = await app.inject({ method: 'GET', url: `/markets/${open}/depth?limit=50` });
    expect(openDepth.statusCode).toBe(200);
    expect(openDepth.json()).toMatchObject({
      marketId: open,
      reduceOnly: false,
      postOnly: false,
    });
    const openL3 = await app.inject({ method: 'GET', url: `/markets/${open}/depth/l3?limit=50` });
    expect(openL3.statusCode).toBe(200);
    expect(openL3.json()).toMatchObject({ marketId: open, reduceOnly: false, postOnly: false });

    const listed = await app.inject({ method: 'GET', url: '/markets' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      venueHalted: false,
      halted: [],
      prelaunch: [],
      expired: [],
      delisted: [],
      reduceOnly: [MARKET],
      postOnly: [OTHER],
    });
    expect(listed.json().markets).toEqual(expect.arrayContaining([MARKET, OTHER, open]));
    expect(listed.json().reduceOnly).not.toContain(open);
    expect(listed.json().postOnly).not.toContain(open);
    expect(listed.json().reduceOnly).not.toContain(OTHER);
    expect(listed.json().postOnly).not.toContain(MARKET);
    await app.close();
  });

  it('missing operator is 400 — no invented caller', async () => {
    const { app, engine } = await mount();
    const res = await post(app, `/markets/${MARKET}/halt`, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BadRequest');
    expect(engine.isHalted(MARKET)).toBe(false);
    await app.close();
  });

  it('unsigned caller is 401', async () => {
    const { app } = await mount();
    const res = await app.inject({
      method: 'POST',
      url: `/markets/${MARKET}/halt`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ operatorId: 'ops-1' }),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('ids without IDENTITY consume refuse unwired — no invented second person', async () => {
    const engine = new MatchingEngine({
      journal: new MemoryJournal(),
      bus: new MemoryEventBus('svc-matching'),
      snapshotEvery: 0,
    });
    const app = Fastify({ logger: false });
    registerRoutes(app, engine, SECRET, { bodyBind: 'require', operatorIds: new Set(['ops-1']) });
    await app.ready();
    const halt = await post(app, `/markets/${MARKET}/halt`, {
      operatorId: 'ops-1',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    expect(halt.statusCode).toBe(400);
    expect(halt.json().code).toBe('action_approval.identity_unwired');
    expect(engine.isHalted(MARKET)).toBe(false);
    await app.close();
  });
});

describe('POST /markets/:marketId/resume', () => {
  it('reopens submits only after the explicit resume door', async () => {
    const { app } = await mount();
    await post(app, `/markets/${MARKET}/halt`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    const blocked = await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '11111111-1111-4111-8111-111111111111' }));
    expect(blocked.json().accepted).toBe(false);

    const resume = await post(app, `/markets/${MARKET}/resume`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-confirm',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json()).toMatchObject({
      accepted: true,
      halted: false,
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-confirm',
      rejected: null,
    });

    const open = await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '22222222-2222-4222-8222-222222222222' }));
    expect(open.statusCode).toBe(200);
    expect(open.json().accepted).toBe(true);
    await app.close();
  });

  it('HTTP resume without confirm refuses and leaves the halt', async () => {
    const { app, engine } = await mount();
    await post(app, `/markets/${MARKET}/halt`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    const resume = await post(app, `/markets/${MARKET}/resume`, { operatorId: 'ops-2' });
    expect(resume.statusCode).toBe(400);
    expect(resume.json().code).toBe('action_approval.missing');
    expect(engine.isHalted(MARKET)).toBe(true);
    await app.close();
  });

  it('missing operator on resume is 400 and leaves the halt', async () => {
    const { app, engine } = await mount();
    await post(app, `/markets/${MARKET}/halt`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    const res = await post(app, `/markets/${MARKET}/resume`, {});
    expect(res.statusCode).toBe(400);
    expect(engine.isHalted(MARKET)).toBe(true);
    expect(MISSING_OPERATOR).toBe('missing_operator');
    await app.close();
  });
});
