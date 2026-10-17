import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { createMarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import { installCodFence } from './engine/cod-fence.js';
import { MatchingEngine } from './engine/engine.js';
import { MemoryJournal } from './engine/journal.js';
import { MARKET_HALTED, MISSING_OPERATOR } from './engine/halt.js';
import { VENUE_HALTED } from './engine/venue-kill.js';
import { registerRoutes } from './router.js';
import { stubApprovalConsumer } from './action-approval-consume.js';

installCodFence();

/**
 * HTTP door for operator halt of ALL markets.
 * Dual-control: operatorId + distinct confirmOperatorId. Missing/same confirm refuses.
 * Cancels stay. Distinct from one-market halt.
 */

const SECRET = 'matching-venue-kill-router-secret32c!!';
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

describe('POST /halt-all', () => {
  it('HTTP halt-all without confirm refuses — no invented second operator', async () => {
    const { app, engine } = await mount();
    const rest = await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '11111111-1111-4111-8111-111111111111' }));
    expect(rest.statusCode).toBe(200);
    expect(rest.json().accepted).toBe(true);

    const halt = await post(app, '/halt-all', { operatorId: 'ops-1' });
    expect(halt.statusCode).toBe(400);
    expect(halt.json().code).toBe('action_approval.missing');
    expect(engine.isVenueHalted).toBe(false);
    expect(halt.json()).not.toHaveProperty('duration');
    expect(halt.json()).not.toHaveProperty('slo');
    expect(halt.json()).not.toHaveProperty('marketId');

    const still = await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '22222222-2222-4222-8222-222222222222' }));
    expect(still.statusCode).toBe(200);
    expect(still.json().accepted).toBe(true);
    await app.close();
  });

  it('HTTP halt-all with two operators is cancel-only — PLACE refuses, rest stays, cancel works', async () => {
    const { app, engine } = await mount();
    const rest = await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '11111111-1111-4111-8111-111111111111' }));
    expect(rest.json().accepted).toBe(true);

    const halt = await post(app, '/halt-all', {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    expect(halt.statusCode).toBe(200);
    expect(halt.json()).toMatchObject({
      accepted: true,
      halted: true,
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-confirm',
      rejected: null,
    });
    expect(engine.isVenueHalted).toBe(true);

    const refused = await post(app, `/markets/${OTHER}/orders`, submitBody(OTHER, { orderId: '33333333-3333-4333-8333-333333333333' }));
    expect(refused.statusCode).toBe(200);
    expect(refused.json().accepted).toBe(false);
    expect(refused.json().rejected.code).toBe(VENUE_HALTED);

    const live = engine.book(MARKET).toState();
    expect(live.asks[0]!.orders[0]!.orderId).toBe('11111111-1111-4111-8111-111111111111');

    const cancelled = await del(app, `/markets/${MARKET}/orders/11111111-1111-4111-8111-111111111111`);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().cancelled).toBe(true);
    await app.close();
  });

  it('same-operator confirm refuses — no invented second caller', async () => {
    const { app, engine } = await mount();
    const halt = await post(app, '/halt-all', { operatorId: 'ops-1', confirmOperatorId: 'ops-1' });
    expect(halt.statusCode).toBe(400);
    expect(halt.json().code).toBe('action_approval.missing');
    expect(engine.isVenueHalted).toBe(false);
    await app.close();
  });

  it('still cancels on a venue-halted market', async () => {
    const { app } = await mount();
    await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '11111111-1111-4111-8111-111111111111' }));
    const halt = await post(app, '/halt-all', {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    expect(halt.json().accepted).toBe(true);

    const cancelled = await del(app, `/markets/${MARKET}/orders/11111111-1111-4111-8111-111111111111`);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().cancelled).toBe(true);
    await app.close();
  });

  it('missing operator is 400 — no invented caller', async () => {
    const { app, engine } = await mount();
    const res = await post(app, '/halt-all', {});
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BadRequest');
    expect(engine.isVenueHalted).toBe(false);
    await app.close();
  });

  it('unsigned caller is 401', async () => {
    const { app } = await mount();
    const res = await app.inject({
      method: 'POST',
      url: '/halt-all',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ operatorId: 'ops-1' }),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('POST /resume-all', () => {
  it('HTTP resume-all without confirm refuses and leaves the halt', async () => {
    const { app, engine } = await mount();
    const halt = await post(app, '/halt-all', {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    expect(halt.json().accepted).toBe(true);
    const blocked = await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '11111111-1111-4111-8111-111111111111' }));
    expect(blocked.json().accepted).toBe(false);
    expect(blocked.json().rejected.code).toBe(VENUE_HALTED);

    const resume = await post(app, '/resume-all', { operatorId: 'ops-2' });
    expect(resume.statusCode).toBe(400);
    expect(resume.json().code).toBe('action_approval.missing');
    expect(engine.isVenueHalted).toBe(true);
    await app.close();
  });

  it('HTTP resume-all with two operators reopens submits', async () => {
    const { app } = await mount();
    const halt = await post(app, '/halt-all', {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    expect(halt.json().accepted).toBe(true);

    const resume = await post(app, '/resume-all', {
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

  it('does not clear one-market halt', async () => {
    const { app, engine } = await mount();
    await post(app, `/markets/${MARKET}/halt`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    const halt = await post(app, '/halt-all', {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    expect(halt.json().accepted).toBe(true);
    const resume = await post(app, '/resume-all', {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-confirm',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    expect(resume.json().accepted).toBe(true);

    expect(engine.isVenueHalted).toBe(false);
    expect(engine.isHalted(MARKET)).toBe(true);

    const blocked = await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '11111111-1111-4111-8111-111111111111' }));
    expect(blocked.json().rejected.code).toBe(MARKET_HALTED);

    const other = await post(app, `/markets/${OTHER}/orders`, submitBody(OTHER, { orderId: '33333333-3333-4333-8333-333333333333' }));
    expect(other.json().accepted).toBe(true);
    await app.close();
  });

  it('missing operator on resume-all is 400 and leaves the halt', async () => {
    const { app, engine } = await mount();
    const halt = await post(app, '/halt-all', {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    expect(halt.json().accepted).toBe(true);
    const res = await post(app, '/resume-all', {});
    expect(res.statusCode).toBe(400);
    expect(engine.isVenueHalted).toBe(true);
    expect(MISSING_OPERATOR).toBe('missing_operator');
    await app.close();
  });
});
