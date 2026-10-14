import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { createMarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import { MatchingEngine } from './engine/engine.js';
import { MemoryJournal } from './engine/journal.js';
import { MISSING_OPERATOR } from './engine/halt.js';
import { MARKET_REDUCE_ONLY } from './engine/reduce-only-market.js';
import { registerRoutes } from './router.js';
import { stubApprovalConsumer } from './action-approval-consume.js';

/**
 * HTTP door for operator reduce-only of one market.
 * Dual-control: operatorId + distinct confirmOperatorId. Missing/same confirm refuses. Missing operator is 400.
 * Open/increase refuse. Reduce-only, close, cancel stay. Resume is a second door.
 * Not halt.
 */

const SECRET = 'matching-reduce-only-router-secret-32c';
const MARKET = 'BTC-USDT';
const OTHER = 'ETH-USDT';

function proofFor(marketId: string) {
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

describe('POST /markets/:marketId/reduce-only', () => {
  it('makes one market reduce-only so opens refuse and another market still takes', async () => {
    const { app } = await mount();
    const liq = await post(
      app,
      `/markets/${MARKET}/orders`,
      submitBody(MARKET, { orderId: '11111111-1111-4111-8111-111111111111', accountId: 'mm', side: 'sell', qty: '2', price: '100' }),
    );
    expect(liq.statusCode).toBe(200);
    const open = await post(
      app,
      `/markets/${MARKET}/orders`,
      submitBody(MARKET, { orderId: '22222222-2222-4222-8222-222222222222', side: 'buy', qty: '2', price: '100' }),
    );
    expect(open.json().accepted).toBe(true);

    const mode = await post(app, `/markets/${MARKET}/reduce-only`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    expect(mode.statusCode).toBe(200);
    expect(mode.json()).toMatchObject({
      accepted: true,
      marketId: MARKET,
      reduceOnly: true,
      operatorId: 'ops-1',
      rejected: null,
    });
    expect(mode.json()).not.toHaveProperty('duration');
    expect(mode.json()).not.toHaveProperty('slo');

    const refused = await post(
      app,
      `/markets/${MARKET}/orders`,
      submitBody(MARKET, { orderId: '33333333-3333-4333-8333-333333333333', side: 'buy', qty: '1', price: '100' }),
    );
    expect(refused.statusCode).toBe(200);
    expect(refused.json().accepted).toBe(false);
    expect(refused.json().rejected.code).toBe(MARKET_REDUCE_ONLY);

    const reducing = await post(
      app,
      `/markets/${MARKET}/orders`,
      submitBody(MARKET, {
        orderId: '44444444-4444-4444-8444-444444444444',
        side: 'sell',
        qty: '1',
        price: '101',
        reduceOnly: true,
      }),
    );
    expect(reducing.statusCode).toBe(200);
    expect(reducing.json().accepted).toBe(true);

    const other = await post(app, `/markets/${OTHER}/orders`, submitBody(OTHER, { orderId: '55555555-5555-4555-8555-555555555555' }));
    expect(other.statusCode).toBe(200);
    expect(other.json().accepted).toBe(true);
    await app.close();
  });

  it('still cancels on a reduce-only market', async () => {
    const { app } = await mount();
    await post(
      app,
      `/markets/${MARKET}/orders`,
      submitBody(MARKET, { orderId: '11111111-1111-4111-8111-111111111111', accountId: 'mm', side: 'sell', qty: '2', price: '100' }),
    );
    await post(
      app,
      `/markets/${MARKET}/orders`,
      submitBody(MARKET, { orderId: '22222222-2222-4222-8222-222222222222', side: 'buy', qty: '2', price: '100' }),
    );
    await post(app, `/markets/${MARKET}/reduce-only`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    await post(
      app,
      `/markets/${MARKET}/orders`,
      submitBody(MARKET, {
        orderId: '44444444-4444-4444-8444-444444444444',
        side: 'sell',
        qty: '1',
        price: '101',
        reduceOnly: true,
      }),
    );

    const cancelled = await del(app, `/markets/${MARKET}/orders/44444444-4444-4444-8444-444444444444`);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().cancelled).toBe(true);
    await app.close();
  });

  it('still closes a position on a reduce-only market', async () => {
    const { app } = await mount();
    await post(
      app,
      `/markets/${MARKET}/orders`,
      submitBody(MARKET, { orderId: '11111111-1111-4111-8111-111111111111', accountId: 'mm', side: 'sell', qty: '2', price: '100' }),
    );
    await post(
      app,
      `/markets/${MARKET}/orders`,
      submitBody(MARKET, { orderId: '22222222-2222-4222-8222-222222222222', side: 'buy', qty: '2', price: '100' }),
    );
    await post(
      app,
      `/markets/${MARKET}/orders`,
      submitBody(MARKET, { orderId: '33333333-3333-4333-8333-333333333333', accountId: 'liq', side: 'buy', qty: '2', price: '100' }),
    );
    await post(app, `/markets/${MARKET}/reduce-only`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });

    const closed = await post(app, `/markets/${MARKET}/positions/close`, {
      orderId: '77777777-7777-4777-8777-777777777777',
      accountId: 'desk',
      lifecycleProof: proofFor(MARKET),
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().accepted).toBe(true);
    await app.close();
  });

  it('missing operator is 400 — no invented caller', async () => {
    const { app, engine } = await mount();
    const res = await post(app, `/markets/${MARKET}/reduce-only`, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BadRequest');
    expect(engine.isReduceOnly(MARKET)).toBe(false);
    await app.close();
  });

  it('unsigned caller is 401', async () => {
    const { app } = await mount();
    const res = await app.inject({
      method: 'POST',
      url: `/markets/${MARKET}/reduce-only`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ operatorId: 'ops-1', confirmOperatorId: 'ops-2', approvalId: 'appr-1', operationId: 'op-1' }),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('POST /markets/:marketId/reduce-only/resume', () => {
  it('reopens opens only after the explicit resume door', async () => {
    const { app } = await mount();
    await post(app, `/markets/${MARKET}/reduce-only`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    const blocked = await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '11111111-1111-4111-8111-111111111111' }));
    expect(blocked.json().accepted).toBe(false);

    const resume = await post(app, `/markets/${MARKET}/reduce-only/resume`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-confirm',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json()).toMatchObject({
      accepted: true,
      reduceOnly: false,
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-confirm',
      rejected: null,
    });

    const open = await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '22222222-2222-4222-8222-222222222222' }));
    expect(open.statusCode).toBe(200);
    expect(open.json().accepted).toBe(true);
    await app.close();
  });

  it('missing operator on resume is 400 and leaves reduce-only', async () => {
    const { app, engine } = await mount();
    await post(app, `/markets/${MARKET}/reduce-only`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    const res = await post(app, `/markets/${MARKET}/reduce-only/resume`, {});
    expect(res.statusCode).toBe(400);
    expect(engine.isReduceOnly(MARKET)).toBe(true);
    expect(MISSING_OPERATOR).toBe('missing_operator');
    await app.close();
  });
});

describe('reduce-only dual-control HTTP', () => {
  it('HTTP reduce-only without confirm refuses — no invented second operator', async () => {
    const { app, engine } = await mount();
    const mode = await post(app, `/markets/${MARKET}/reduce-only`, { operatorId: 'ops-1' });
    expect(mode.statusCode).toBe(400);
    expect(mode.json().code).toBe('action_approval.missing');
    expect(engine.isReduceOnly(MARKET)).toBe(false);
    await app.close();
  });

  it('same-operator confirm refuses reduce-only and resume', async () => {
    const { app, engine } = await mount();
    const mode = await post(app, `/markets/${MARKET}/reduce-only`, { operatorId: 'ops-1', confirmOperatorId: 'ops-1' });
    expect(mode.statusCode).toBe(400);
    expect(mode.json().code).toBe('action_approval.missing');
    expect(engine.isReduceOnly(MARKET)).toBe(false);

    await post(app, `/markets/${MARKET}/reduce-only`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    const resume = await post(app, `/markets/${MARKET}/reduce-only/resume`, { operatorId: 'ops-2', confirmOperatorId: 'ops-2' });
    expect(resume.statusCode).toBe(400);
    expect(resume.json().code).toBe('action_approval.missing');
    expect(engine.isReduceOnly(MARKET)).toBe(true);
    await app.close();
  });
});
