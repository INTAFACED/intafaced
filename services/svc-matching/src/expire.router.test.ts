import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { createMarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import { MatchingEngine } from './engine/engine.js';
import { MemoryJournal } from './engine/journal.js';
import { MARKET_HALTED, MISSING_OPERATOR } from './engine/halt.js';
import { MARKET_PRELAUNCH } from './engine/prelaunch.js';
import { MARKET_DELISTED, MARKET_EXPIRED } from './engine/expire.js';
import { registerRoutes } from './router.js';
import { stubApprovalConsumer } from './action-approval-consume.js';

/**
 * HTTP door for operator expire/delist of one market.
 * Dual-control: operatorId + distinct confirmOperatorId. Missing/same confirm refuses. Missing operator is 400.
 * New submits refuse. Cancels stay. Distinct from halt/prelaunch. No notice period.
 */

const SECRET = 'matching-expire-router-secret-32chars!!';
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

describe('POST /markets/:marketId/expire', () => {
  it('expires one market so new submits refuse and another market still takes', async () => {
    const { app } = await mount();
    const rest = await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '11111111-1111-4111-8111-111111111111' }));
    expect(rest.statusCode).toBe(200);
    expect(rest.json().accepted).toBe(true);

    const expired = await post(app, `/markets/${MARKET}/expire`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    expect(expired.statusCode).toBe(200);
    expect(expired.json()).toMatchObject({
      accepted: true,
      marketId: MARKET,
      expired: true,
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-confirm',
      rejected: null,
    });
    expect(expired.json()).not.toHaveProperty('notice');
    expect(expired.json()).not.toHaveProperty('noticePeriod');
    expect(expired.json()).not.toHaveProperty('duration');
    expect(expired.json()).not.toHaveProperty('slo');

    const refused = await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '22222222-2222-4222-8222-222222222222' }));
    expect(refused.statusCode).toBe(200);
    expect(refused.json().accepted).toBe(false);
    expect(refused.json().rejected.code).toBe(MARKET_EXPIRED);

    const other = await post(app, `/markets/${OTHER}/orders`, submitBody(OTHER, { orderId: '33333333-3333-4333-8333-333333333333' }));
    expect(other.statusCode).toBe(200);
    expect(other.json().accepted).toBe(true);
    await app.close();
  });

  it('still cancels on an expired market', async () => {
    const { app } = await mount();
    await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '11111111-1111-4111-8111-111111111111' }));
    await post(app, `/markets/${MARKET}/expire`, {
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

  it('is not halt — resume still refuses as market_expired', async () => {
    const { app } = await mount();
    await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '11111111-1111-4111-8111-111111111111' }));
    await post(app, `/markets/${MARKET}/halt`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    await post(app, `/markets/${MARKET}/expire`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    await post(app, `/markets/${MARKET}/resume`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-confirm',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });

    const refused = await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '22222222-2222-4222-8222-222222222222' }));
    expect(refused.json().accepted).toBe(false);
    expect(refused.json().rejected.code).toBe(MARKET_EXPIRED);
    expect(refused.json().rejected.code).not.toBe(MARKET_HALTED);
    await app.close();
  });

  it('is not prelaunch — open still refuses as market_expired', async () => {
    const { app } = await mount();
    await post(app, `/markets/${MARKET}/prelaunch`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    await post(app, `/markets/${MARKET}/expire`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    await post(app, `/markets/${MARKET}/open`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-confirm',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });

    const refused = await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '22222222-2222-4222-8222-222222222222' }));
    expect(refused.json().accepted).toBe(false);
    expect(refused.json().rejected.code).toBe(MARKET_EXPIRED);
    expect(refused.json().rejected.code).not.toBe(MARKET_PRELAUNCH);
    await app.close();
  });

  it('missing operator is 400 — no invented caller', async () => {
    const { app, engine } = await mount();
    const res = await post(app, `/markets/${MARKET}/expire`, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BadRequest');
    expect(engine.isExpired(MARKET)).toBe(false);
    await app.close();
  });

  it('unsigned caller is 401', async () => {
    const { app } = await mount();
    const res = await app.inject({
      method: 'POST',
      url: `/markets/${MARKET}/expire`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ operatorId: 'ops-1', confirmOperatorId: 'ops-2', approvalId: 'appr-1', operationId: 'op-1' }),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('POST /markets/:marketId/delist', () => {
  it('delists one market so new submits refuse and another market still takes', async () => {
    const { app } = await mount();
    const rest = await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '11111111-1111-4111-8111-111111111111' }));
    expect(rest.json().accepted).toBe(true);

    const delisted = await post(app, `/markets/${MARKET}/delist`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    expect(delisted.statusCode).toBe(200);
    expect(delisted.json()).toMatchObject({
      accepted: true,
      marketId: MARKET,
      delisted: true,
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-confirm',
      rejected: null,
    });
    expect(delisted.json()).not.toHaveProperty('notice');
    expect(delisted.json()).not.toHaveProperty('noticePeriod');
    expect(delisted.json()).not.toHaveProperty('duration');

    const refused = await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '22222222-2222-4222-8222-222222222222' }));
    expect(refused.json().accepted).toBe(false);
    expect(refused.json().rejected.code).toBe(MARKET_DELISTED);

    const other = await post(app, `/markets/${OTHER}/orders`, submitBody(OTHER, { orderId: '33333333-3333-4333-8333-333333333333' }));
    expect(other.json().accepted).toBe(true);
    await app.close();
  });

  it('still cancels on a delisted market', async () => {
    const { app } = await mount();
    await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '11111111-1111-4111-8111-111111111111' }));
    await post(app, `/markets/${MARKET}/delist`, {
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

  it('is not expire — expire still refuses as market_expired', async () => {
    const { app } = await mount();
    await post(app, `/markets/${MARKET}/expire`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    const refused = await post(app, `/markets/${MARKET}/orders`, submitBody(MARKET, { orderId: '22222222-2222-4222-8222-222222222222' }));
    expect(refused.json().rejected.code).toBe(MARKET_EXPIRED);
    expect(refused.json().rejected.code).not.toBe(MARKET_DELISTED);
    await app.close();
  });

  it('missing operator is 400 — no invented caller', async () => {
    const { app, engine } = await mount();
    const res = await post(app, `/markets/${MARKET}/delist`, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BadRequest');
    expect(engine.isDelisted(MARKET)).toBe(false);
    expect(MISSING_OPERATOR).toBe('missing_operator');
    await app.close();
  });

  it('unsigned caller is 401', async () => {
    const { app } = await mount();
    const res = await app.inject({
      method: 'POST',
      url: `/markets/${MARKET}/delist`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ operatorId: 'ops-1', confirmOperatorId: 'ops-2', approvalId: 'appr-1', operationId: 'op-1' }),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('expire/delist dual-control HTTP', () => {
  it('HTTP expire without confirm refuses — no invented second operator', async () => {
    const { app, engine } = await mount();
    const expired = await post(app, `/markets/${MARKET}/expire`, { operatorId: 'ops-1' });
    expect(expired.statusCode).toBe(400);
    expect(expired.json().code).toBe('action_approval.missing');
    expect(engine.isExpired(MARKET)).toBe(false);
    await app.close();
  });

  it('same-operator confirm refuses expire and delist', async () => {
    const { app, engine } = await mount();
    const expired = await post(app, `/markets/${MARKET}/expire`, { operatorId: 'ops-1', confirmOperatorId: 'ops-1' });
    expect(expired.statusCode).toBe(400);
    expect(expired.json().code).toBe('action_approval.missing');
    expect(engine.isExpired(MARKET)).toBe(false);

    const delisted = await post(app, `/markets/${MARKET}/delist`, { operatorId: 'ops-1', confirmOperatorId: 'ops-1' });
    expect(delisted.statusCode).toBe(400);
    expect(delisted.json().code).toBe('action_approval.missing');
    expect(engine.isDelisted(MARKET)).toBe(false);
    await app.close();
  });
});
