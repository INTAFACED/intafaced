import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { createMarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import { MatchingEngine } from './engine/engine.js';
import { MemoryJournal } from './engine/journal.js';
import { registerRoutes } from './router.js';

/**
 * HTTP door for IOC. Take what is there. Unfilled remainder cancels.
 * No invented leftover.
 */

const SECRET = 'matching-ioc-router-secret-32charsxx';
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
    side: 'buy' as const,
    qty: '1',
    price: '99',
    tif: 'IOC' as const,
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

describe('POST /markets/:marketId/orders IOC', () => {
  it('partial take cancels the leftover through the door', async () => {
    const { app, engine } = await mount();
    const ask = await post(
      app,
      submitBody({
        orderId: '11111111-1111-4111-8111-111111111111',
        accountId: 'mm',
        side: 'sell',
        qty: '1',
        price: '100',
        tif: 'GTC',
      }),
    );
    expect(ask.statusCode).toBe(200);
    expect(ask.json().accepted).toBe(true);

    const res = await post(
      app,
      submitBody({
        orderId: '22222222-2222-4222-8222-222222222222',
        qty: '3',
        price: '100',
        tif: 'IOC',
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toBe(true);
    expect(res.json().fills).toHaveLength(1);
    expect(res.json().fills[0].qty).toBe('1');
    expect(res.json().resting).toBeNull();
    expect(res.json().cancellations).toEqual([
      expect.objectContaining({
        orderId: '22222222-2222-4222-8222-222222222222',
        remainingQty: '2',
        reason: 'ioc_remainder',
      }),
    ]);
    const live = engine.book(MARKET).toState();
    const ids = [...live.bids.flatMap((l) => l.orders.map((o) => o.orderId)), ...live.asks.flatMap((l) => l.orders.map((o) => o.orderId))];
    expect(ids).not.toContain('22222222-2222-4222-8222-222222222222');
    await app.close();
  });

  it('empty-book IOC does not invent a leftover rest', async () => {
    const { app, engine } = await mount();
    const res = await post(app, submitBody());
    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toBe(true);
    expect(res.json().resting).toBeNull();
    expect(res.json().cancellations[0].reason).toBe('ioc_remainder');
    expect(res.json().cancellations[0].remainingQty).toBe('1');
    expect(engine.book(MARKET).toState().bids).toEqual([]);
    await app.close();
  });

  it('GTC still rests on an empty book', async () => {
    const { app } = await mount();
    const res = await post(
      app,
      submitBody({
        orderId: '44444444-4444-4444-8444-444444444444',
        tif: 'GTC',
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toBe(true);
    expect(res.json().resting).toMatchObject({ kind: 'book', remaining: '1' });
    await app.close();
  });
});
