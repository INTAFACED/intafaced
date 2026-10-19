import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { createMarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import { MatchingEngine } from './engine/engine.js';
import { MemoryJournal } from './engine/journal.js';
import { registerRoutes } from './router.js';

/**
 * HTTP door for OCO: take-profit and stop-loss legs ride the submit body into the engine.
 */

const SECRET = 'matching-iceberg-router-secret-32char';
const MARKET = 'BTC-USDT';

function proofFor() {
  const observedAt = '2026-08-24T16:00:00.000Z';
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
    orderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    accountId: 'desk',
    type: 'limit' as const,
    side: 'sell' as const,
    qty: '10',
    price: '100',
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
  registerRoutes(app, engine, SECRET, { bodyBind: 'require' });
  await app.ready();
  return { app, engine };
}

function post(app: FastifyInstance, payloadBody: unknown) {
  const payload = JSON.stringify(payloadBody);
  return app.inject({
    method: 'POST',
    url: `/markets/${MARKET}/orders`,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-trade', SECRET, payload) },
    payload,
  });
}

describe('POST /markets/:marketId/orders OCO', () => {
  it('carries take-profit and stop-loss to the engine: one submit rests both legs, linked', async () => {
    const { app, engine } = await mount();
    const res = await post(app, submitBody({ oco: true, takeProfit: '110', stopLoss: '90', price: '110' }));
    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toBe(true);
    const state = engine.book(MARKET).toState();
    expect(state.asks[0]!.orders[0]!.orderId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:tp');
    expect(state.asks[0]!.price).toBe('110');
    expect(state.stops.map((s) => [s.orderId, s.stopPrice])).toEqual([['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:sl', '90']]);
    await app.close();
  });

  it('refuses a missing leg with a typed rejection and rests nothing', async () => {
    const { app, engine } = await mount();
    for (const over of [{ oco: true, takeProfit: '110' }, { oco: true, stopLoss: '90' }, { oco: true }]) {
      const res = await post(app, submitBody(over));
      expect(res.statusCode).toBe(200);
      expect(res.json().accepted).toBe(false);
      expect(res.json().rejected.code).toBe('missing_stop_price');
    }
    expect(engine.book(MARKET).toState().asks).toEqual([]);
    expect(engine.book(MARKET).toState().stops).toEqual([]);
    await app.close();
  });

  it('an explicit null leg on a plain order is not an OCO', async () => {
    const { app, engine } = await mount();
    const res = await post(app, submitBody({ takeProfit: null, stopLoss: null }));
    expect(res.json().accepted).toBe(true);
    expect(engine.book(MARKET).toState().asks[0]!.orders[0]!.orderId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    await app.close();
  });
});
