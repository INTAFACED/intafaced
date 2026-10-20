/**
 * HTTP doors for the spread book (CB-otc-16).
 * GET /spreads lists owner spread instruments (empty when none). GET /spreads/:id/book reads the spread book in
 * spread-price units. POST /spreads/:id/list takes the same dual-control approval as OPEN and binds the exact
 * definition. POST /spreads/:id/orders places a GTC spread order; a fill carries every leg or nothing prints.
 */
import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { createMarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import { MatchingEngine } from './engine/engine.js';
import { MemoryJournal } from './engine/journal.js';
import type { SpreadFillEvent } from './engine/spread-book.js';
import { registerRoutes } from './router.js';
import { stubApprovalConsumer, type ActionApprovalConsumer } from './action-approval-consume.js';

const SECRET = 'matching-spread-router-secret-32chars!!';
const CAL = 'BTC-CAL-MAR-JUN';
const NEAR = 'BTC-27MAR';
const FAR = 'BTC-26JUN';

const LISTING = {
  kind: 'calendar',
  legs: [
    { symbol: NEAR, side: 'sell', ratio: '1' },
    { symbol: FAR, side: 'buy', ratio: '1' },
  ],
  tick: '0.5',
  lot: '0.001',
  operatorId: 'ops-1',
  confirmOperatorId: 'ops-confirm',
  approvalId: 'appr-1',
  operationId: 'op-1',
};

function proofFor(marketId: string) {
  const observedAt = '2026-10-20T12:00:00.000Z';
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

function orderBody(over: Record<string, unknown> = {}) {
  return {
    orderId: '11111111-1111-4111-8111-111111111111',
    accountId: 'mm',
    side: 'sell',
    qty: '2',
    price: '150',
    tif: 'GTC',
    anchorReference: '60000',
    lifecycleProof: proofFor(CAL),
    ...over,
  };
}

async function mount(): Promise<{ app: FastifyInstance; engine: MatchingEngine; fills: SpreadFillEvent[]; consumed: () => number }> {
  const fills: SpreadFillEvent[] = [];
  const engine = new MatchingEngine({
    journal: new MemoryJournal(),
    bus: new MemoryEventBus('svc-matching'),
    snapshotEvery: 0,
    spreadFills: { publish: (event) => void fills.push(event) },
  });
  const stub = stubApprovalConsumer('ops-confirm');
  let count = 0;
  const approvals: ActionApprovalConsumer = {
    consume(input) {
      count += 1;
      return stub.consume(input);
    },
  };
  const app = Fastify({ logger: false });
  registerRoutes(app, engine, SECRET, { bodyBind: 'require', approvals, operatorIds: new Set(['ops-1', 'ops-confirm']) });
  await app.ready();
  return { app, engine, fills, consumed: () => count };
}

function post(app: FastifyInstance, url: string, body: unknown, signed = true) {
  const payload = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      ...(signed ? serviceAuthHeadersForBody('svc-trade', SECRET, payload) : {}),
    },
    payload,
  });
}

describe('GET /spreads and /spreads/:id/book', () => {
  it('given no listing, the list is empty and a book read refuses spread_unlisted', async () => {
    const { app } = await mount();
    const list = await app.inject({ method: 'GET', url: '/spreads' });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ instruments: [] });

    const book = await app.inject({ method: 'GET', url: `/spreads/${CAL}/book?limit=10` });
    expect(book.statusCode).toBe(404);
    expect(book.json().code).toBe('spread_unlisted');
    await app.close();
  });

  it('a book read without a limit refuses rather than inventing one', async () => {
    const { app } = await mount();
    const book = await app.inject({ method: 'GET', url: `/spreads/${CAL}/book` });
    expect(book.statusCode).toBe(400);
    await app.close();
  });
});

describe('POST /spreads/:id/list', () => {
  it('lists through dual-control approval; the list and the book show it', async () => {
    const { app, consumed } = await mount();
    const listed = await post(app, `/spreads/${CAL}/list`, LISTING);
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      accepted: true,
      spreadId: CAL,
      alreadyListed: false,
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-confirm',
      rejected: null,
      instrument: { spreadId: CAL, kind: 'calendar', tick: '0.5', lot: '0.001' },
    });
    expect(consumed()).toBe(1);

    const list = await app.inject({ method: 'GET', url: '/spreads' });
    expect(list.json().instruments).toEqual([
      {
        spreadId: CAL,
        kind: 'calendar',
        legs: [
          { symbol: NEAR, side: 'sell', ratio: '1' },
          { symbol: FAR, side: 'buy', ratio: '1' },
        ],
        tick: '0.5',
        lot: '0.001',
      },
    ]);
    const book = await app.inject({ method: 'GET', url: `/spreads/${CAL}/book?limit=10` });
    expect(book.json()).toMatchObject({ spreadId: CAL, bids: [], asks: [], bestBid: null, bestAsk: null, lastPrice: null });
    await app.close();
  });

  it('a blank owner field refuses typed and does not spend the approval', async () => {
    const { app, engine, consumed } = await mount();
    const refused = await post(app, `/spreads/${CAL}/list`, { ...LISTING, tick: '' });
    expect(refused.statusCode).toBe(200);
    expect(refused.json()).toMatchObject({ accepted: false, rejected: { code: 'spread_tick_missing' } });
    expect(consumed()).toBe(0);
    expect(engine.spreadInstruments()).toEqual([]);
    await app.close();
  });

  it('an unsigned listing is 401', async () => {
    const { app } = await mount();
    const refused = await post(app, `/spreads/${CAL}/list`, LISTING, false);
    expect(refused.statusCode).toBe(401);
    await app.close();
  });
});

describe('POST /spreads/:id/orders', () => {
  it('rests and fills at the spread price; the fill carries both legs as decimal strings', async () => {
    const { app, fills } = await mount();
    await post(app, `/spreads/${CAL}/list`, LISTING);

    const maker = await post(app, `/spreads/${CAL}/orders`, orderBody());
    expect(maker.json()).toMatchObject({ accepted: true, resting: { price: '150', remaining: '2' } });
    const book = await app.inject({ method: 'GET', url: `/spreads/${CAL}/book?limit=10` });
    expect(book.json()).toMatchObject({ asks: [['150', '2']], bestAsk: '150' });

    const taker = await post(
      app,
      `/spreads/${CAL}/orders`,
      orderBody({ orderId: '22222222-2222-4222-8222-222222222222', accountId: 'taker', side: 'buy', qty: '2', price: '155' }),
    );
    expect(taker.statusCode).toBe(200);
    expect(taker.json().fills).toEqual([
      {
        sequence: 3,
        makerOrderId: '11111111-1111-4111-8111-111111111111',
        makerAccountId: 'mm',
        takerOrderId: '22222222-2222-4222-8222-222222222222',
        takerAccountId: 'taker',
        takerSide: 'buy',
        price: '150',
        qty: '2',
        legs: [
          { symbol: NEAR, takerSide: 'sell', qty: '2', price: '60000' },
          { symbol: FAR, takerSide: 'buy', qty: '2', price: '60150' },
        ],
      },
    ]);
    expect(fills).toHaveLength(1);
    const after = await app.inject({ method: 'GET', url: `/spreads/${CAL}/book?limit=10` });
    expect(after.json()).toMatchObject({ asks: [], lastPrice: '150' });
    await app.close();
  });

  it('a negative spread price is accepted on the spread door', async () => {
    const { app } = await mount();
    await post(app, `/spreads/${CAL}/list`, LISTING);
    const negative = await post(app, `/spreads/${CAL}/orders`, orderBody({ side: 'buy', price: '-25' }));
    expect(negative.json()).toMatchObject({ accepted: true, resting: { price: '-25' } });
    // The outright depth doors still read a spread book: decimal strings, and SBE refuses or encodes, never a 500.
    const depth = await app.inject({ method: 'GET', url: `/markets/${CAL}/depth?limit=10` });
    expect(depth.json()).toMatchObject({ bids: [['-25', '2']], asks: [] });
    const sbe = await app.inject({ method: 'GET', url: `/markets/${CAL}/depth/sbe?limit=10` });
    expect([200, 409]).toContain(sbe.statusCode);
    await app.close();
  });

  it('given one leg halted, the whole spread refuses', async () => {
    const { app, engine, fills } = await mount();
    await post(app, `/spreads/${CAL}/list`, LISTING);
    await post(app, `/spreads/${CAL}/orders`, orderBody());
    await engine.halt(NEAR, { operatorId: 'ops-1', confirmOperatorId: 'ops-confirm' });
    const refused = await post(
      app,
      `/spreads/${CAL}/orders`,
      orderBody({ orderId: '33333333-3333-4333-8333-333333333333', accountId: 'taker', side: 'buy' }),
    );
    expect(refused.json()).toMatchObject({ accepted: false, fills: [], rejected: { code: 'spread_leg_unavailable' } });
    expect(fills).toHaveLength(0);
    await app.close();
  });

  it('an unlisted spread refuses spread_unlisted; a proof for another market is 400', async () => {
    const { app } = await mount();
    const unlisted = await post(app, `/spreads/${CAL}/orders`, orderBody());
    expect(unlisted.json().rejected.code).toBe('spread_unlisted');
    const wrongProof = await post(app, `/spreads/${CAL}/orders`, orderBody({ lifecycleProof: proofFor('BTC-USDT') }));
    expect(wrongProof.statusCode).toBe(400);
    await app.close();
  });

  it('an outright order on the spread id refuses, and a spread order cancels through the normal door', async () => {
    const { app } = await mount();
    await post(app, `/spreads/${CAL}/list`, LISTING);
    await post(app, `/spreads/${CAL}/orders`, orderBody());

    const outright = await post(app, `/markets/${CAL}/orders`, {
      orderId: '44444444-4444-4444-8444-444444444444',
      accountId: 'acct',
      type: 'limit',
      side: 'buy',
      qty: '1',
      price: '150',
      tif: 'GTC',
      lifecycleProof: proofFor(CAL),
    });
    expect(outright.json().rejected.code).toBe('spread_book_outright_refused');

    const payload = '';
    const cancel = await app.inject({
      method: 'DELETE',
      url: `/markets/${CAL}/orders/11111111-1111-4111-8111-111111111111`,
      headers: { ...serviceAuthHeadersForBody('svc-trade', SECRET, payload) },
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toMatchObject({ cancelled: true });
    await app.close();
  });
});
