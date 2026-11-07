/**
 * My place in the queue and the estimated fill chance (J-charts-desk-14 #8, RC-charts-desk-01).
 *
 * Promise: the place comes from matching's native queue at the order's own price and side, counting only orders with a
 * lower sequence; nothing about another maker but the count and summed size leaves; the chance is served only with the
 * owner's window and never passes 1; another person's order is not found; a filled order is not open; a market with no
 * L3 refuses and never falls back to L2.
 */
import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyReply } from 'fastify';
import type { Principal } from '@intafaced/auth';
import { parseAmount } from '@intafaced/ledger-client/money';
import { TradeError, type OrderRecord, type PublicTapePrint } from './types.js';
import {
  attachQueuePositionRoute,
  fillEstimate,
  placeInQueue,
  QUEUE_L3_UNAVAILABLE,
  QUEUE_PROBABILITY_UNSET,
  type L3Answer,
  type QueuePositionDeps,
} from './queue-position.js';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const a = (value: string) => parseAmount(value);

function principal(userId = ME): Principal {
  return {
    sub: userId,
    userId,
    sid: 's',
    scopes: ['trade:read'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

function order(over: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: 'o-mine',
    userId: ME,
    marketId: 'm-btc',
    side: 'buy',
    type: 'limit',
    price: a('100'),
    qty: a('2'),
    filledQty: a('0'),
    status: 'open',
    ...over,
  } as OrderRecord;
}

/** Three resting bids at 100 (sequences 1, 2, 3): mine is sequence 2. Another level and the asks hold more orders. */
const L3: L3Answer = {
  level: 'L3',
  bids: [
    {
      price: '100',
      orders: [
        { orderId: 'o-first', remaining: '1.5', sequence: 1 },
        { orderId: 'o-mine', remaining: '2', sequence: 2 },
        { orderId: 'o-third', remaining: '4', sequence: 3 },
      ],
    },
    { price: '99', orders: [{ orderId: 'o-lower', remaining: '9', sequence: 0 }] },
  ],
  asks: [{ price: '100', orders: [{ orderId: 'o-ask', remaining: '7', sequence: 0 }] }],
};

const print = (price: string, qty: string): PublicTapePrint =>
  ({ id: `${price}:${qty}`, side: 'sell', price: a(price), qty: a(qty), quoteAmount: 0n, sequence: 0, ts: new Date() }) as PublicTapePrint;

describe('place in the queue', () => {
  it('counts only the orders ahead at its own price and side, by sequence', () => {
    const place = placeInQueue(L3, order());
    expect(place.ordersAhead).toBe(1);
    expect(place.sizeAhead).toBe(a('1.5'));
    expect(place.sequence).toBe(2);
    expect(place.remaining).toBe(a('2'));
  });

  it('a market matching serves no L3 for refuses, and never reads L2', () => {
    expect(() => placeInQueue({ accepted: false, level: null, rejected: { code: 'l3_unavailable', message: 'no L3' } }, order())).toThrow(
      expect.objectContaining({ code: QUEUE_L3_UNAVAILABLE }),
    );
    expect(() => placeInQueue({ level: 'L2', bids: [] }, order())).toThrow(expect.objectContaining({ code: QUEUE_L3_UNAVAILABLE }));
  });

  it('an order not in the queue at its price is unavailable, not placed first', () => {
    expect(() => placeInQueue(L3, order({ id: 'o-gone' }))).toThrow(expect.objectContaining({ code: 'trade.queue_unavailable' }));
  });
});

describe('estimated fill chance', () => {
  it('trades at or through a buy price over the size to clear, capped at 1', () => {
    const prints = [print('100', '1'), print('99.5', '0.5'), print('101', '5')];
    // 1.5 traded at or below 100; 1.5 ahead plus 2 of mine to clear.
    expect(fillEstimate('buy', a('100'), prints, a('1.5'), a('2')).probability).toBe('0.428571428571428571');
    expect(fillEstimate('buy', a('100'), [...prints, print('90', '10')], a('1.5'), a('2')).probability).toBe('1');
    expect(fillEstimate('buy', a('100'), [], a('1.5'), a('2')).probability).toBe('0');
  });

  it('a sell counts the trades at or above its price', () => {
    expect(fillEstimate('sell', a('100'), [print('101', '1'), print('99', '5')], a('0'), a('2')).probability).toBe('0.5');
  });
});

async function build(over: Partial<QueuePositionDeps> = {}, who: Principal = principal()) {
  const seenSince: number[] = [];
  const deps: QueuePositionDeps = {
    async getOrder(caller, id) {
      const found = id === 'o-mine' ? order() : id === 'o-filled' ? order({ id, status: 'closed' }) : null;
      if (!found || found.userId !== caller.userId) throw new TradeError(`order ${id} not found`, 'trade.order_not_found');
      return found;
    },
    marketById: async () => ({ id: 'm-btc', symbol: 'BTC/USDT' }),
    l3: async () => L3,
    tapeSince: async (_marketId, sinceMs) => {
      seenSince.push(sinceMs);
      return [print('100', '1'), print('99.5', '0.5')];
    },
    windowSeconds: async () => 300,
    now: () => new Date('2026-11-07T08:00:00.000Z'),
    ...over,
  };
  const app = Fastify({ logger: false });
  attachQueuePositionRoute(app, deps, (_req, _reply: FastifyReply) => who);
  await app.ready();
  return { app, seenSince };
}

describe('GET /api/v1/orders/:id/queue', () => {
  it('answers my place and the estimate over the owner window, and names no other maker', async () => {
    const { app, seenSince } = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/orders/o-mine/queue' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      orderId: 'o-mine',
      symbol: 'BTC/USDT',
      side: 'buy',
      price: '100',
      remaining: '2',
      ordersAhead: 1,
      sizeAhead: '1.5',
      source: 'native_l3',
      windowSeconds: 300,
      tradedInWindow: '1.5',
      fillProbability: '0.428571428571428571',
      fillProbabilityRefusal: null,
    });
    expect(seenSince).toEqual([Date.parse('2026-11-07T08:00:00.000Z') - 300_000]);
    expect(res.body).not.toContain('o-first');
    expect(res.body).not.toContain('o-third');
  });

  it('a blank owner window gives the place and refuses the chance, with no percent', async () => {
    const { app } = await build({ windowSeconds: async () => null });
    const body = (await app.inject({ method: 'GET', url: '/api/v1/orders/o-mine/queue' })).json();
    expect(body.ordersAhead).toBe(1);
    expect(body.fillProbability).toBeNull();
    expect(body.fillProbabilityRefusal).toBe(QUEUE_PROBABILITY_UNSET);
  });

  it("another person's order is not found, with no hint that it exists", async () => {
    const { app } = await build({}, principal(OTHER));
    const res = await app.inject({ method: 'GET', url: '/api/v1/orders/o-mine/queue' });
    expect(res.statusCode).toBe(404);
    expect(res.json().intafacedCode).toBe('trade.order_not_found');
  });

  it('a filled order is not open', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/orders/o-filled/queue' });
    expect(res.statusCode).toBe(409);
    expect(res.json().intafacedCode).toBe('trade.order_not_open');
  });

  it('matching down refuses as unavailable', async () => {
    const { app } = await build({
      l3: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/orders/o-mine/queue' });
    expect(res.statusCode).toBe(503);
    expect(res.json().intafacedCode).toBe('trade.queue_unavailable');
  });
});
