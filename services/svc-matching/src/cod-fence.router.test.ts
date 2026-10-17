/**
 * HTTP door for the COD fence (cancel-on-disconnect), not the unit fence alone.
 * Existing engine fence stays; this only proves POST /session/dead reaches it.
 * TIF magnitudes are not invented — sessionId is the caller tag.
 */
import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { createMarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import { installCodFence } from './engine/cod-fence.js';
import { MatchingEngine } from './engine/engine.js';
import { MemoryJournal } from './engine/journal.js';
import { SESSION_GONE } from './engine/session.js';
import { MISSING_OPERATOR } from './engine/halt.js';
import { registerRoutes } from './router.js';
import { stubApprovalConsumer } from './action-approval-consume.js';

installCodFence();

const SECRET = 'matching-cod-fence-http-door-secret32';
const MARKET = 'BTC-USDT';
const REST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AFTER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function proofFor() {
  const observedAt = '2026-09-04T16:00:00.000Z';
  return createMarketLifecycleAdmissionProof(
    {
      marketId: MARKET,
      ruleVersion: 'test.rules.v1',
      instrumentId: MARKET,
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

function submitBody(over: Record<string, unknown> = {}) {
  return {
    orderId: REST,
    accountId: 'desk',
    type: 'limit' as const,
    side: 'sell' as const,
    qty: '1.25',
    price: '100.50',
    tif: 'GTC' as const,
    lifecycleProof: proofFor(),
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

function post(app: FastifyInstance, url: string, payloadBody: unknown, service = 'svc-trade') {
  const payload = JSON.stringify(payloadBody);
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, SECRET, payload) },
    payload,
  });
}

describe('COD fence through the matching HTTP door', () => {
  it('signed session-dead cancels the tagged rest and later tagged submit is session_gone', async () => {
    const { app } = await mount();
    const rest = await post(app, `/markets/${MARKET}/orders`, submitBody({ sessionId: 'sess-cod' }), 'svc-fix');
    expect(rest.statusCode).toBe(200);
    expect(rest.json().accepted).toBe(true);
    expect(rest.json().resting.remaining).toBe('1.25');

    const dead = await post(app, '/session/dead', { sessionId: 'sess-cod' }, 'svc-fix');
    expect(dead.statusCode).toBe(200);
    expect(dead.json().accepted).toBe(true);
    expect(dead.json().sessionId).toBe('sess-cod');
    expect(dead.json().cancellations.map((c: { orderId: string; reason: string }) => [c.orderId, c.reason])).toEqual([
      [REST, 'session_dead'],
    ]);

    const later = await post(
      app,
      `/markets/${MARKET}/orders`,
      submitBody({ orderId: AFTER, sessionId: 'sess-cod', side: 'buy', price: '100.50' }),
      'svc-fix',
    );
    expect(later.statusCode).toBe(200);
    expect(later.json().accepted).toBe(false);
    expect(later.json().rejected.code).toBe(SESSION_GONE);
    expect(later.json().fills).toEqual([]);
    await app.close();
  });

  it('unsigned COD session-dead is 401; unmapped svc-pay is 403', async () => {
    const { app } = await mount();
    await post(app, `/markets/${MARKET}/orders`, submitBody({ sessionId: 'sess-cod' }), 'svc-fix');

    const unsigned = await app.inject({
      method: 'POST',
      url: '/session/dead',
      headers: { 'content-type': 'application/json', 'x-intafaced-service': 'svc-fix' },
      payload: JSON.stringify({ sessionId: 'sess-cod' }),
    });
    expect(unsigned.statusCode).toBe(401);

    const unmapped = await post(app, '/session/dead', { sessionId: 'sess-cod' }, 'svc-pay');
    expect(unmapped.statusCode).toBe(403);
    await app.close();
  });

  it('HTTP halt-all without confirm hits the fence refuse — no invented second operator', async () => {
    const { app, engine } = await mount();
    const halt = await post(app, '/halt-all', { operatorId: 'ops-1' });
    expect(halt.statusCode).toBe(400);
    expect(halt.json().code).toBe('action_approval.missing');
    expect(engine.isVenueHalted).toBe(false);
    await app.close();
  });

  it('HTTP halt-all with two operators applies — fence does not invent a second caller', async () => {
    const { app, engine } = await mount();
    const halt = await post(app, '/halt-all', {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    expect(halt.statusCode).toBe(200);
    expect(halt.json().accepted).toBe(true);
    expect(halt.json().confirmOperatorId).toBe('ops-confirm');
    expect(engine.isVenueHalted).toBe(true);
    await app.close();
  });

  it('HTTP one-market halt without confirm hits the fence refuse — no invented second operator', async () => {
    const { app, engine } = await mount();
    const halt = await post(app, `/markets/${MARKET}/halt`, { operatorId: 'ops-1' });
    expect(halt.statusCode).toBe(400);
    expect(halt.json().code).toBe('action_approval.missing');
    expect(engine.isHalted(MARKET)).toBe(false);
    await app.close();
  });

  it('HTTP one-market halt with two operators applies — fence does not invent a second caller', async () => {
    const { app, engine } = await mount();
    const halt = await post(app, `/markets/${MARKET}/halt`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    expect(halt.statusCode).toBe(200);
    expect(halt.json().accepted).toBe(true);
    expect(halt.json().confirmOperatorId).toBe('ops-confirm');
    expect(engine.isHalted(MARKET)).toBe(true);
    await app.close();
  });
});
