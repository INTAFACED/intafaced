import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { createMarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import { MatchingEngine } from './engine/engine.js';
import { MemoryJournal } from './engine/journal.js';
import { MARKET_HALTED, MISSING_OPERATOR } from './engine/halt.js';
import { MARKET_PRELAUNCH } from './engine/prelaunch.js';
import { registerRoutes } from './router.js';
import { stubApprovalConsumer } from './action-approval-consume.js';

/**
 * HTTP door for operator prelaunch of one market.
 * Dual-control: operatorId + distinct confirmOperatorId. Missing/same confirm refuses. Missing operator is 400.
 * Public submits refuse until OPEN. Cancel of nothing is 404 without inventing.
 * Distinct from halt.
 */

const SECRET = 'matching-prelaunch-router-secret-32ch!!';
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
  registerRoutes(app, engine, SECRET, { bodyBind: 'require', approvals: stubApprovalConsumer('ops-confirm') });
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

describe('POST /markets/:marketId/prelaunch', () => {
  it('prelaunches one market so public submits refuse and another market still takes', async () => {
    const { app } = await mount();
    const mode = await post(app, `/markets/${MARKET}/prelaunch`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    expect(mode.statusCode).toBe(200);
    expect(mode.json()).toMatchObject({
      accepted: true,
      marketId: MARKET,
      prelaunch: true,
      operatorId: 'ops-1',
      rejected: null,
    });
    expect(mode.json()).not.toHaveProperty('duration');
    expect(mode.json()).not.toHaveProperty('slo');

    const refused = await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '22222222-2222-4222-8222-222222222222' }));
    expect(refused.statusCode).toBe(200);
    expect(refused.json().accepted).toBe(false);
    expect(refused.json().rejected.code).toBe(MARKET_PRELAUNCH);

    const other = await post(app, `/markets/${OTHER}/orders`, submitBody(OTHER, { orderId: '33333333-3333-4333-8333-333333333333' }));
    expect(other.statusCode).toBe(200);
    expect(other.json().accepted).toBe(true);
    await app.close();
  });

  it('cancel of nothing is 404 and does not list the market', async () => {
    const { app } = await mount();
    await post(app, `/markets/${MARKET}/prelaunch`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });

    const cancelled = await del(app, `/markets/${MARKET}/orders/11111111-1111-4111-8111-111111111111`);
    expect(cancelled.statusCode).toBe(404);

    const listed = await app.inject({ method: 'GET', url: '/markets' });
    expect(listed.json().markets).not.toContain(MARKET);
    await app.close();
  });

  it('is not halt — halt still refuses as market_halted after open', async () => {
    const { app } = await mount();
    await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '11111111-1111-4111-8111-111111111111' }));
    await post(app, `/markets/${MARKET}/halt`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    await post(app, `/markets/${MARKET}/prelaunch`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    await post(app, `/markets/${MARKET}/open`, {
      operatorId: 'ops-2',
      confirmOperatorId: 'ops-confirm',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });

    const refused = await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '22222222-2222-4222-8222-222222222222' }));
    expect(refused.statusCode).toBe(200);
    expect(refused.json().accepted).toBe(false);
    expect(refused.json().rejected.code).toBe(MARKET_HALTED);
    await app.close();
  });

  it('missing operator is 400 — no invented caller', async () => {
    const { app, engine } = await mount();
    const res = await post(app, `/markets/${MARKET}/prelaunch`, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BadRequest');
    expect(engine.isPrelaunch(MARKET)).toBe(false);
    await app.close();
  });

  it('unsigned caller is 401', async () => {
    const { app } = await mount();
    const res = await app.inject({
      method: 'POST',
      url: `/markets/${MARKET}/prelaunch`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ operatorId: 'ops-1', confirmOperatorId: 'ops-2', approvalId: 'appr-1', operationId: 'op-1' }),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('POST /markets/:marketId/open', () => {
  it('accepts public submits only after the explicit open door', async () => {
    const { app } = await mount();
    await post(app, `/markets/${MARKET}/prelaunch`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    const blocked = await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '11111111-1111-4111-8111-111111111111' }));
    expect(blocked.json().accepted).toBe(false);

    const opened = await post(app, `/markets/${MARKET}/open`, {
      operatorId: 'ops-2',
      confirmOperatorId: 'ops-confirm',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({
      accepted: true,
      prelaunch: false,
      operatorId: 'ops-2',
      confirmOperatorId: 'ops-confirm',
      rejected: null,
    });

    const live = await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '22222222-2222-4222-8222-222222222222' }));
    expect(live.statusCode).toBe(200);
    expect(live.json().accepted).toBe(true);
    await app.close();
  });

  it('an approved open lists the empty market in GET /markets, an unapproved open does not', async () => {
    const { app } = await mount();

    const refused = await post(app, `/markets/${MARKET}/open`, { operatorId: 'ops-2', confirmOperatorId: 'ops-2' });
    expect(refused.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/markets' })).json().markets).not.toContain(MARKET);

    const opened = await post(app, `/markets/${MARKET}/open`, {
      operatorId: 'ops-2',
      confirmOperatorId: 'ops-confirm',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    expect(opened.json().accepted).toBe(true);

    const board = (await app.inject({ method: 'GET', url: '/markets' })).json();
    expect(board.markets).toEqual([MARKET]);
    expect(board.prelaunch).toEqual([]);
    await app.close();
  });

  it('missing operator on open is 400 and leaves prelaunch', async () => {
    const { app, engine } = await mount();
    await post(app, `/markets/${MARKET}/prelaunch`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    const res = await post(app, `/markets/${MARKET}/open`, {});
    expect(res.statusCode).toBe(400);
    expect(engine.isPrelaunch(MARKET)).toBe(true);
    expect(MISSING_OPERATOR).toBe('missing_operator');
    await app.close();
  });
});

describe('prelaunch/open dual-control HTTP', () => {
  it('HTTP prelaunch without confirm refuses — no invented second operator', async () => {
    const { app, engine } = await mount();
    const mode = await post(app, `/markets/${MARKET}/prelaunch`, { operatorId: 'ops-1' });
    expect(mode.statusCode).toBe(400);
    expect(mode.json().code).toBe('action_approval.missing');
    expect(engine.isPrelaunch(MARKET)).toBe(false);
    await app.close();
  });

  it('same-operator confirm refuses prelaunch and open', async () => {
    const { app, engine } = await mount();
    const mode = await post(app, `/markets/${MARKET}/prelaunch`, { operatorId: 'ops-1', confirmOperatorId: 'ops-1' });
    expect(mode.statusCode).toBe(400);
    expect(mode.json().code).toBe('action_approval.missing');
    expect(engine.isPrelaunch(MARKET)).toBe(false);

    await post(app, `/markets/${MARKET}/prelaunch`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    const opened = await post(app, `/markets/${MARKET}/open`, { operatorId: 'ops-2', confirmOperatorId: 'ops-2' });
    expect(opened.statusCode).toBe(400);
    expect(opened.json().code).toBe('action_approval.missing');
    expect(engine.isPrelaunch(MARKET)).toBe(true);
    await app.close();
  });
});
