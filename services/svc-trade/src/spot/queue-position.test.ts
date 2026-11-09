/**
 * My place in the queue (RC-charts-desk-01, J-charts-desk-14 #8). The position comes from matching's native L3 queue;
 * the fill estimate exists only with the owner's window; other makers' ids and single sizes never leave; L3 down refuses
 * and never falls back to L2.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { parseAmount } from '@intafaced/ledger-client';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { registerPrivateRest, type PrivateRestDeps } from '../private-rest.js';
import { MatchingUnavailableError, type EngineL3Queue } from './matching-client.js';
import { fillEstimate, placeInQueue, readQueuePosition, TRADE_QUEUE_PROBABILITY_UNSET, type QueuePositionDeps } from './queue-position.js';
import { TradeError, type OrderRecord } from './types.js';

const ME = '11111111-1111-4111-8111-111111111111';
const MINE = '33333333-3333-4333-8333-333333333333';
const FIRST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const THIRD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MARKET = 'BTC-USDT';
const principal = { sub: ME, userId: ME, scopes: ['trade:read'] } as unknown as Principal;

/** Three resting bids at 100 (sequences 1, 2, 3); mine is sequence 2. A bid at 99 and an ask at 100 are not my queue. */
const QUEUE: EngineL3Queue = {
  level: 'L3',
  marketId: MARKET,
  sequence: 42,
  bids: [
    {
      price: '100',
      orders: [
        { orderId: FIRST, remaining: '0.25', sequence: 1 },
        { orderId: MINE, remaining: '0.5', sequence: 2 },
        { orderId: THIRD, remaining: '7', sequence: 3 },
      ],
    },
    { price: '99', orders: [{ orderId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', remaining: '9', sequence: 0 }] },
  ],
  asks: [{ price: '100.5', orders: [{ orderId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', remaining: '3', sequence: 4 }] }],
};

function order(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: MINE,
    userId: ME,
    marketId: MARKET,
    side: 'buy',
    type: 'limit',
    price: parseAmount('100'),
    qty: parseAmount('0.5'),
    filledQty: 0n,
    status: 'open',
    ...overrides,
  } as OrderRecord;
}

function deps(overrides: Partial<QueuePositionDeps> = {}): QueuePositionDeps {
  return {
    getOrder: async (p, id) => {
      if (id !== MINE || p.userId !== ME) throw new TradeError(`order ${id} not found`, 'trade.order_not_found');
      return order();
    },
    marketById: async () => ({ symbol: 'BTC/USDT' }),
    l3Queue: async () => QUEUE,
    queueFillWindowSeconds: async () => null,
    tradedThrough: async () => 0n,
    now: () => new Date('2026-11-09T00:00:00.000Z'),
    ...overrides,
  };
}

describe('placeInQueue', () => {
  it('counts only the orders at my price and side with a lower sequence', () => {
    expect(placeInQueue(QUEUE, 'buy', parseAmount('100'), MINE)).toEqual({
      ordersAhead: 1,
      sizeAhead: parseAmount('0.25'),
      remaining: parseAmount('0.5'),
    });
  });

  it('the first in the queue has nothing ahead', () => {
    expect(placeInQueue(QUEUE, 'buy', parseAmount('100'), FIRST)).toEqual({
      ordersAhead: 0,
      sizeAhead: 0n,
      remaining: parseAmount('0.25'),
    });
  });

  it('an order not in the queue at that price is not placed', () => {
    expect(placeInQueue(QUEUE, 'buy', parseAmount('99'), MINE)).toBeNull();
    expect(placeInQueue(QUEUE, 'sell', parseAmount('100'), MINE)).toBeNull();
  });
});

describe('fillEstimate (traded through the window / size to fill, capped at 1, floored to 4 places)', () => {
  const place = { ordersAhead: 2, sizeAhead: parseAmount('0.002'), remaining: parseAmount('0.001') };
  it('a third of the size to fill traded: 0.3333', () => expect(fillEstimate(place, parseAmount('0.001'))).toBe('0.3333'));
  it('nothing traded through: 0', () => expect(fillEstimate(place, 0n)).toBe('0'));
  it('more than the size to fill traded: 1, never more', () => expect(fillEstimate(place, parseAmount('5'))).toBe('1'));
});

describe('readQueuePosition', () => {
  it('answers ordersAhead 1 and sizeAhead the remaining of sequence 1, with no other maker id or single size', async () => {
    const view = await readQueuePosition(deps(), principal, MINE);
    expect(view).toMatchObject({
      orderId: MINE,
      marketId: MARKET,
      symbol: 'BTC/USDT',
      side: 'buy',
      price: '100',
      ordersAhead: 1,
      sizeAhead: '0.25',
      remaining: '0.5',
      asOfSequence: 42,
      source: 'native_l3',
    });
    const wire = JSON.stringify(view);
    for (const other of [FIRST, THIRD, 'dddddddd', 'eeeeeeee']) expect(wire).not.toContain(other);
    expect(wire).not.toContain('"7"');
  });

  it('with the window blank: no percent at all, and the typed reason', async () => {
    const view = await readQueuePosition(deps(), principal, MINE);
    expect(view).not.toHaveProperty('fillProbability');
    expect(view).not.toHaveProperty('fillProbabilityBasis');
    expect(view.fillProbabilityRefused?.code).toBe(TRADE_QUEUE_PROBABILITY_UNSET);
  });

  it('with the window set: the estimate and its basis, from the volume at or through my price since now − window', async () => {
    const asked: Array<[string, string, bigint, number]> = [];
    const view = await readQueuePosition(
      deps({
        queueFillWindowSeconds: async () => 300,
        tradedThrough: async (marketId, side, price, sinceMs) => {
          asked.push([marketId, side, price, sinceMs]);
          return parseAmount('0.25');
        },
      }),
      principal,
      MINE,
    );
    expect(asked).toEqual([[MARKET, 'buy', parseAmount('100'), Date.parse('2026-11-09T00:00:00.000Z') - 300_000]]);
    expect(view.fillProbability).toBe('0.3333');
    expect(view.fillProbabilityBasis).toEqual({
      method: 'traded_through_window',
      windowSeconds: 300,
      tradedThrough: '0.25',
      sizeToFill: '0.75',
    });
    expect(view).not.toHaveProperty('fillProbabilityRefused');
  });

  it("another person's order id is the same not-found as no order", async () => {
    await expect(readQueuePosition(deps(), principal, FIRST)).rejects.toMatchObject({ code: 'trade.order_not_found' });
  });

  it('a filled order refuses trade.order_not_open', async () => {
    const d = deps({ getOrder: async () => order({ status: 'filled' }) });
    await expect(readQueuePosition(d, principal, MINE)).rejects.toMatchObject({ code: 'trade.order_not_open' });
  });

  it('an open order matching no longer holds at its price refuses trade.order_not_open', async () => {
    const d = deps({ l3Queue: async () => ({ ...QUEUE, bids: [] }) });
    await expect(readQueuePosition(d, principal, MINE)).rejects.toMatchObject({ code: 'trade.order_not_open' });
  });

  it('L3 down refuses trade.queue_unavailable and reads nothing else', async () => {
    let traded = 0;
    const d = deps({
      l3Queue: async () => {
        throw new MatchingUnavailableError('svc-matching /depth/l3 is unreachable', 'trade.queue_unavailable');
      },
      queueFillWindowSeconds: async () => 300,
      tradedThrough: async () => {
        traded += 1;
        return 0n;
      },
    });
    await expect(readQueuePosition(d, principal, MINE)).rejects.toMatchObject({ code: 'trade.queue_unavailable' });
    expect(traded).toBe(0);
  });
});

describe('GET /api/v1/orders/:id/queue', () => {
  const SECRET = 'a-trade-private-rest-queue-position-edge-secret';
  function headers(): Record<string, string> {
    const p = {
      sub: ME,
      userId: ME,
      sid: '22222222-2222-4222-8222-222222222222',
      scopes: ['trade:read'],
      tier: 'basic',
      mfa: false,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal;
    const raw = encodePrincipal(p);
    return {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    };
  }
  async function get(d: Partial<PrivateRestDeps>, id = MINE) {
    const app = Fastify({ logger: false });
    registerPrivateRest(app, { edgeSecret: SECRET, serviceName: 'svc-trade', ...d } as unknown as PrivateRestDeps);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: `/api/v1/orders/${id}/queue`, headers: headers() });
    await app.close();
    return res;
  }

  it('answers the position read', async () => {
    const res = await get({ orderQueue: (p, id) => readQueuePosition(deps(), p, id) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ orderId: MINE, ordersAhead: 1, sizeAhead: '0.25', source: 'native_l3' });
  });

  it("maps another person's order to 404 trade.order_not_found", async () => {
    const res = await get({ orderQueue: (p, id) => readQueuePosition(deps(), p, id) }, FIRST);
    expect(res.statusCode).toBe(404);
    expect(res.json().intafacedCode).toBe('trade.order_not_found');
  });

  it('maps L3 down to 503 trade.queue_unavailable', async () => {
    const d = deps({
      l3Queue: async () => {
        throw new MatchingUnavailableError('down', 'trade.queue_unavailable');
      },
    });
    const res = await get({ orderQueue: (p, id) => readQueuePosition(d, p, id) });
    expect(res.statusCode).toBe(503);
    expect(res.json().intafacedCode).toBe('trade.queue_unavailable');
  });

  it('refuses a malformed id as not found before any read, and a typed 503 when unwired', async () => {
    expect((await get({ orderQueue: async () => ({}) as never }, 'not-an-id')).json().intafacedCode).toBe('trade.order_not_found');
    const res = await get({});
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('trade.queue_unconfigured');
  });
});
