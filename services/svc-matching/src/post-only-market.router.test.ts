import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { createMarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import { MatchingEngine } from './engine/engine.js';
import { MemoryJournal } from './engine/journal.js';
import { MISSING_OPERATOR } from './engine/halt.js';
import { MARKET_POST_ONLY } from './engine/post-only-market.js';
import { registerRoutes } from './router.js';
import { stubApprovalConsumer } from './action-approval-consume.js';

/**
 * HTTP door for operator post-only of one market.
 * Dual-control: operatorId + distinct confirmOperatorId. Missing/same confirm refuses. Missing operator is 400.
 * Non-post-only refuse. Taking PO still refuses. Cancel stays. Resume is a second door.
 * Not halt.
 */

const SECRET = 'matching-post-only-mkt-router-secret32';
const MARKET = 'BTC-USDT';
const OTHER = 'ETH-USDT';

function proofFor(marketId: string, action: 'PLACE' | 'PLACE_POST_ONLY' = 'PLACE') {
  const observedAt = '2026-08-26T16:00:00.000Z';
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
    action,
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

describe('POST /markets/:marketId/post-only', () => {
  it('makes one market post-only so GTC refuses, PO rests, and another market still takes', async () => {
    const { app } = await mount();
    const ask = await post(
      app,
      `/markets/${MARKET}/orders`,
      submitBody(MARKET, { orderId: '11111111-1111-4111-8111-111111111111', accountId: 'mm', side: 'sell', qty: '1', price: '100' }),
    );
    expect(ask.statusCode).toBe(200);
    expect(ask.json().accepted).toBe(true);

    const mode = await post(app, `/markets/${MARKET}/post-only`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    expect(mode.statusCode).toBe(200);
    expect(mode.json()).toMatchObject({
      accepted: true,
      marketId: MARKET,
      postOnly: true,
      operatorId: 'ops-1',
      rejected: null,
    });
    expect(mode.json()).not.toHaveProperty('duration');
    expect(mode.json()).not.toHaveProperty('slo');

    const refused = await post(
      app,
      `/markets/${MARKET}/orders`,
      submitBody(MARKET, { orderId: '22222222-2222-4222-8222-222222222222', side: 'buy', qty: '1', price: '99' }),
    );
    expect(refused.statusCode).toBe(200);
    expect(refused.json().accepted).toBe(false);
    expect(refused.json().rejected.code).toBe(MARKET_POST_ONLY);

    const resting = await post(
      app,
      `/markets/${MARKET}/orders`,
      submitBody(MARKET, {
        orderId: '33333333-3333-4333-8333-333333333333',
        side: 'buy',
        qty: '1',
        price: '99',
        tif: 'PO',
        lifecycleProof: proofFor(MARKET, 'PLACE_POST_ONLY'),
      }),
    );
    expect(resting.statusCode).toBe(200);
    expect(resting.json().accepted).toBe(true);

    const crossed = await post(
      app,
      `/markets/${MARKET}/orders`,
      submitBody(MARKET, {
        orderId: '44444444-4444-4444-8444-444444444444',
        side: 'buy',
        qty: '1',
        price: '100',
        tif: 'PO',
        lifecycleProof: proofFor(MARKET, 'PLACE_POST_ONLY'),
      }),
    );
    expect(crossed.statusCode).toBe(200);
    expect(crossed.json().accepted).toBe(false);
    expect(crossed.json().rejected.code).toBe('post_only_would_cross');

    const other = await post(app, `/markets/${OTHER}/orders`, submitBody(OTHER, { orderId: '55555555-5555-4555-8555-555555555555' }));
    expect(other.statusCode).toBe(200);
    expect(other.json().accepted).toBe(true);
    await app.close();
  });

  it('still cancels on a post-only market', async () => {
    const { app } = await mount();
    await post(
      app,
      `/markets/${MARKET}/orders`,
      submitBody(MARKET, { orderId: '11111111-1111-4111-8111-111111111111', accountId: 'mm', side: 'sell', qty: '1', price: '100' }),
    );
    await post(app, `/markets/${MARKET}/post-only`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    await post(
      app,
      `/markets/${MARKET}/orders`,
      submitBody(MARKET, {
        orderId: '33333333-3333-4333-8333-333333333333',
        side: 'buy',
        qty: '1',
        price: '99',
        tif: 'PO',
        lifecycleProof: proofFor(MARKET, 'PLACE_POST_ONLY'),
      }),
    );

    const cancelled = await del(app, `/markets/${MARKET}/orders/33333333-3333-4333-8333-333333333333`);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().cancelled).toBe(true);
    await app.close();
  });

  it('missing operator is 400 — no invented caller', async () => {
    const { app, engine } = await mount();
    const res = await post(app, `/markets/${MARKET}/post-only`, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BadRequest');
    expect(engine.isPostOnly(MARKET)).toBe(false);
    await app.close();
  });

  it('unsigned caller is 401', async () => {
    const { app } = await mount();
    const res = await app.inject({
      method: 'POST',
      url: `/markets/${MARKET}/post-only`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ operatorId: 'ops-1', confirmOperatorId: 'ops-2', approvalId: 'appr-1', operationId: 'op-1' }),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('POST /markets/:marketId/post-only/resume', () => {
  it('reopens non-post-only submits only after the explicit resume door', async () => {
    const { app } = await mount();
    await post(app, `/markets/${MARKET}/post-only`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    const blocked = await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '11111111-1111-4111-8111-111111111111' }));
    expect(blocked.json().accepted).toBe(false);

    const resume = await post(app, `/markets/${MARKET}/post-only/resume`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-confirm',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json()).toMatchObject({
      accepted: true,
      postOnly: false,
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-confirm',
      rejected: null,
    });

    const open = await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '22222222-2222-4222-8222-222222222222' }));
    expect(open.statusCode).toBe(200);
    expect(open.json().accepted).toBe(true);
    await app.close();
  });

  it('missing operator on resume is 400 and leaves post-only', async () => {
    const { app, engine } = await mount();
    await post(app, `/markets/${MARKET}/post-only`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    const res = await post(app, `/markets/${MARKET}/post-only/resume`, {});
    expect(res.statusCode).toBe(400);
    expect(engine.isPostOnly(MARKET)).toBe(true);
    expect(MISSING_OPERATOR).toBe('missing_operator');
    await app.close();
  });
});

describe('post-only dual-control HTTP', () => {
  it('HTTP post-only without confirm refuses — no invented second operator', async () => {
    const { app, engine } = await mount();
    const mode = await post(app, `/markets/${MARKET}/post-only`, { operatorId: 'ops-1' });
    expect(mode.statusCode).toBe(400);
    expect(mode.json().code).toBe('action_approval.missing');
    expect(engine.isPostOnly(MARKET)).toBe(false);
    await app.close();
  });

  it('same-operator confirm refuses post-only and resume', async () => {
    const { app, engine } = await mount();
    const mode = await post(app, `/markets/${MARKET}/post-only`, { operatorId: 'ops-1', confirmOperatorId: 'ops-1' });
    expect(mode.statusCode).toBe(400);
    expect(mode.json().code).toBe('action_approval.missing');
    expect(engine.isPostOnly(MARKET)).toBe(false);

    await post(app, `/markets/${MARKET}/post-only`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    const resume = await post(app, `/markets/${MARKET}/post-only/resume`, { operatorId: 'ops-2', confirmOperatorId: 'ops-2' });
    expect(resume.statusCode).toBe(400);
    expect(resume.json().code).toBe('action_approval.missing');
    expect(engine.isPostOnly(MARKET)).toBe(true);
    await app.close();
  });
});
