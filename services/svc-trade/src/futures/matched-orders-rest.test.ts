import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { parseAmount } from '@intafaced/ledger-client';
import { attachMatchedOrderRoutes, readPlaceBody, type FuturesOrderWire, type MatchedOrdersRestDeps } from './matched-orders-rest.js';
import { MatchedOrderError, type PlaceMatchedOrderInput } from './matched-orders.js';
import type { ReverseInput, ReverseView } from './reverse.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const principal = { userId: USER, scopes: ['trade:read', 'trade:write'], tier: 2 } as unknown as Principal;

const order: FuturesOrderWire = {
  orderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  marketId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  clientOrderId: 'open:jd:1',
  userId: USER,
  side: 'buy',
  type: 'limit',
  qty: '0.01',
  limitPrice: '65000',
  markPrice: '65010',
  bandLow: '61759.5',
  bandHigh: '68260.5',
  holdAmount: '65',
  filledQty: '0',
  appliedAmount: '0',
  releasedAmount: '0',
  feesPaid: '0',
  status: 'open',
  refusalCode: null,
  reduceOnly: false,
  positionId: null,
  bankruptcyPrice: null,
};

async function app(deps: MatchedOrdersRestDeps, opts: { signedIn?: boolean; jurisdiction?: boolean } = {}) {
  const server = Fastify();
  attachMatchedOrderRoutes(server, deps, {
    requirePrincipal: (_req, reply) => {
      if (opts.signedIn === false) {
        void reply.code(401).send({ error: 'trade.unauthenticated' });
        return null;
      }
      return principal;
    },
    requireTradeJurisdiction: (_req, reply) => {
      if (opts.jurisdiction === false) {
        void reply.code(403).send({ error: 'trade.jurisdiction' });
        return false;
      }
      return true;
    },
    regionOf: () => 'EU',
    sendDomainError: () => null,
  });
  await server.ready();
  return server;
}

const body = {
  symbol: 'BTC/USDT:USDT',
  side: 'buy',
  type: 'limit',
  amount: '0.01',
  price: '65000',
  leverage: '5',
  clientOrderId: 'desk-1',
};

describe('futures orders through the book: REST', () => {
  it('places with exact decimals, the signed account and the edge region', async () => {
    const seen: { input: PlaceMatchedOrderInput; region: string | null | undefined }[] = [];
    const server = await app({
      place: async (_p, input, context) => {
        seen.push({ input, region: context.region });
        return order;
      },
    });
    const res = await server.inject({ method: 'POST', url: '/api/v1/futures/orders', payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(order);
    expect(seen).toEqual([
      {
        input: {
          userId: USER,
          symbol: 'BTC/USDT:USDT',
          side: 'buy',
          type: 'limit',
          qty: parseAmount('0.01'),
          limitPrice: parseAmount('65000'),
          leverage: parseAmount('5'),
          clientOrderId: 'desk-1',
          marginMode: 'isolated',
        },
        region: 'EU',
      },
    ]);
  });

  it('passes a named collateral class to the service, which decides; omitted sends none', async () => {
    const seen: PlaceMatchedOrderInput[] = [];
    const server = await app({
      place: async (_p, input) => {
        seen.push(input);
        return order;
      },
    });
    await server.inject({ method: 'POST', url: '/api/v1/futures/orders', payload: { ...body, collateralClass: 'staked' } });
    await server.inject({ method: 'POST', url: '/api/v1/futures/orders', payload: body });
    expect(seen.map((input) => input.collateralClass)).toEqual(['staked', undefined]);
    expect('collateralClass' in seen[1]!).toBe(false);
  });

  it('refuses a JSON number, a missing leverage on an opening order, cross margin and a missing clientOrderId before the service', async () => {
    let calls = 0;
    const server = await app({
      place: async () => {
        calls += 1;
        return order;
      },
    });
    const cases: [Record<string, unknown>, string][] = [
      [{ ...body, amount: 0.01 }, 'trade.size_invalid'],
      [{ ...body, price: 65000 }, 'trade.invalid_price'],
      [{ ...body, leverage: undefined }, 'trade.leverage_required'],
      [{ ...body, marginMode: 'cross' }, 'trade.margin_mode_unavailable'],
      [{ ...body, clientOrderId: '' }, 'trade.client_order_id_required'],
      [{ ...body, side: 'long' }, 'trade.side_invalid'],
      [{ ...body, type: 'stop' }, 'trade.order_type_invalid'],
      [{ ...body, reduceOnly: 'yes' }, 'trade.reduce_only_invalid'],
      [{ ...body, timeInForce: 'IOC' }, 'trade.time_in_force_unsupported'],
      [{ ...body, type: 'market', price: undefined, timeInForce: 'FOK' }, 'trade.time_in_force_unsupported'],
    ];
    for (const [payload, code] of cases) {
      const res = await server.inject({ method: 'POST', url: '/api/v1/futures/orders', payload });
      expect(res.statusCode, code).toBe(400);
      expect(res.json().error).toBe(code);
    }
    expect(calls).toBe(0);
  });

  it('a reduce-only order needs no leverage: it keeps the position’s own', () => {
    const read = readPlaceBody(USER, { ...body, type: 'market', price: undefined, leverage: undefined, reduceOnly: true, side: 'sell' });
    expect(read).toMatchObject({ ok: true, input: { reduceOnly: true, type: 'market', side: 'sell' } });
    expect(read.ok ? read.input.limitPrice : 'unread').toBeUndefined();
    expect(readPlaceBody(USER, { ...body, timeInForce: 'GTC' }).ok).toBe(true);
  });

  it('a market order that carries a price is refused, never silently re-priced (open, reduce and split)', async () => {
    let calls = 0;
    const server = await app({
      place: async () => {
        calls += 1;
        return order;
      },
      placeSplit: async () => {
        calls += 1;
        return { parts: 1, orders: [order], stopped: null };
      },
    });
    const cases: [string, Record<string, unknown>][] = [
      ['/api/v1/futures/orders', { ...body, type: 'market', price: '65000' }],
      ['/api/v1/futures/orders', { ...body, type: 'market', price: '1', leverage: undefined, reduceOnly: true, side: 'sell' }],
      ['/api/v1/futures/orders/split', { ...body, type: 'market', price: '65000' }],
    ];
    for (const [url, payload] of cases) {
      const res = await server.inject({ method: 'POST', url, payload });
      expect(res.statusCode, url).toBe(400);
      expect(res.json()).toMatchObject({ error: 'trade.price_not_accepted' });
    }
    expect(calls).toBe(0);
    // A limit order still names its price.
    expect(readPlaceBody(USER, body)).toMatchObject({ ok: true, input: { type: 'limit', limitPrice: parseAmount('65000') } });
  });

  it('a typed service refusal keeps its code and status', async () => {
    const server = await app({
      place: async () => {
        throw new MatchedOrderError('the limit is outside the price band around the mark', 'trade.futures_price_outside_band', 400);
      },
    });
    const res = await server.inject({ method: 'POST', url: '/api/v1/futures/orders', payload: body });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'trade.futures_price_outside_band' });
  });

  it('the jurisdiction gate holds a new order back but never a cancel', async () => {
    let cancelled = 0;
    const server = await app(
      {
        place: async () => order,
        cancel: async () => {
          cancelled += 1;
          return { ...order, status: 'cancelled' };
        },
      },
      { jurisdiction: false },
    );
    expect((await server.inject({ method: 'POST', url: '/api/v1/futures/orders', payload: body })).statusCode).toBe(403);
    const res = await server.inject({ method: 'DELETE', url: `/api/v1/futures/orders/${order.orderId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('cancelled');
    expect(cancelled).toBe(1);
  });

  it('lists the signed account’s orders; a blank scope or limit refuses rather than picking one', async () => {
    const seen: unknown[] = [];
    const server = await app({
      list: async (p, input) => {
        seen.push({ userId: p.userId, ...input });
        return [order];
      },
    });
    const ok = await server.inject({ method: 'GET', url: '/api/v1/futures/orders?scope=open&limit=50&symbol=BTC/USDT:USDT' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual([order]);
    expect(seen).toEqual([{ userId: USER, scope: 'open', limit: 50, symbol: 'BTC/USDT:USDT' }]);
    expect((await server.inject({ method: 'GET', url: '/api/v1/futures/orders?limit=50' })).json().error).toBe(
      'trade.futures_orders_scope_invalid',
    );
    expect((await server.inject({ method: 'GET', url: '/api/v1/futures/orders?scope=all' })).json().error).toBe(
      'trade.futures_orders_limit_unset',
    );
    expect((await server.inject({ method: 'GET', url: '/api/v1/futures/orders?scope=all&limit=501' })).statusCode).toBe(400);
    expect(seen).toHaveLength(1);
  });

  it('the split door reads the same body, passes priceCorrection as sent and answers every child placed', async () => {
    const seen: PlaceMatchedOrderInput[] = [];
    const children = [
      { ...order, clientOrderId: 'desk-1:1' },
      { ...order, clientOrderId: 'desk-1:2' },
    ];
    const server = await app({
      placeSplit: async (_p, input) => {
        seen.push(input);
        return { parts: 2, orders: children, stopped: null };
      },
    });
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/futures/orders/split',
      payload: { ...body, priceCorrection: 'adjust' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ parts: 2, orders: children, stopped: null });
    expect(seen[0]).toMatchObject({ clientOrderId: 'desk-1', qty: parseAmount('0.01'), priceCorrection: 'adjust' });
    // A malformed body never reaches the service; an unwired split door is 503.
    expect((await server.inject({ method: 'POST', url: '/api/v1/futures/orders/split', payload: { ...body, amount: 1 } })).statusCode).toBe(
      400,
    );
    expect(seen).toHaveLength(1);
    const bare = await app({ place: async () => order });
    const unwired = await bare.inject({ method: 'POST', url: '/api/v1/futures/orders/split', payload: body });
    expect(unwired.statusCode).toBe(503);
    const out = await app({ placeSplit: async () => ({ parts: 1, orders: [order], stopped: null }) }, { jurisdiction: false });
    expect((await out.inject({ method: 'POST', url: '/api/v1/futures/orders/split', payload: body })).statusCode).toBe(403);
  });

  it('confirmTier is passed to both doors as sent, and a malformed one never reaches the service', async () => {
    const seen: PlaceMatchedOrderInput[] = [];
    const server = await app({
      place: async (_p, input) => {
        seen.push(input);
        return order;
      },
      placeSplit: async (_p, input) => {
        seen.push(input);
        return { parts: 1, orders: [order], stopped: null };
      },
    });
    expect((await server.inject({ method: 'POST', url: '/api/v1/futures/orders', payload: { ...body, confirmTier: 3 } })).statusCode).toBe(
      200,
    );
    expect(
      (await server.inject({ method: 'POST', url: '/api/v1/futures/orders/split', payload: { ...body, confirmTier: 2 } })).statusCode,
    ).toBe(200);
    expect((await server.inject({ method: 'POST', url: '/api/v1/futures/orders', payload: body })).statusCode).toBe(200);
    expect(seen.map((input) => input.confirmTier)).toEqual([3, 2, undefined]);
    for (const confirmTier of ['3', 0, 1.5]) {
      const res = await server.inject({ method: 'POST', url: '/api/v1/futures/orders', payload: { ...body, confirmTier } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('trade.confirm_tier_invalid');
    }
    expect(seen).toHaveLength(3);
  });

  it('signed out is 401 and an unwired door is 503, never a pretend order', async () => {
    const out = await app({ place: async () => order }, { signedIn: false });
    expect((await out.inject({ method: 'POST', url: '/api/v1/futures/orders', payload: body })).statusCode).toBe(401);
    const bare = await app({});
    const res = await bare.inject({ method: 'GET', url: '/api/v1/futures/orders?scope=open&limit=5' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('trade.futures_orders_unmounted');
  });

  describe('a take profit and stop loss on an opening order (J-derivatives-03 #4)', () => {
    const protection = {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      symbol: 'BTC/USDT:USDT',
      clientOrderId: 'desk-1',
      side: 'buy' as const,
      takeProfit: '70000',
      stopLoss: '60000',
      status: 'waiting' as const,
      armedQuantity: '0',
      takeProfitClientOrderId: null,
      stopLossClientOrderId: null,
      createdAt: '2026-10-23T00:00:00.000Z',
      updatedAt: '2026-10-23T00:00:00.000Z',
    };

    it('is recorded before the order is placed, and answered with it', async () => {
      const calls: string[] = [];
      const server = await app({
        place: async () => {
          calls.push('place');
          return order;
        },
        entryProtection: {
          record: async (userId, input) => {
            calls.push('record');
            expect({ userId, ...input }).toEqual({
              userId: USER,
              symbol: 'BTC/USDT:USDT',
              side: 'buy',
              reduceOnly: false,
              clientOrderId: 'desk-1',
              takeProfit: '70000',
              stopLoss: '60000',
            });
            return protection;
          },
        },
      });
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/futures/orders',
        payload: { ...body, takeProfit: '70000', stopLoss: '60000' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ...order, protection });
      expect(calls).toEqual(['record', 'place']);
    });

    it('a refused protection places nothing; an order with none never asks', async () => {
      let placed = 0;
      const server = await app({
        place: async () => {
          placed += 1;
          return order;
        },
        entryProtection: {
          record: async (_u, input) => {
            if (input.takeProfit === undefined) throw new Error('asked without a protection');
            throw new MatchedOrderError('takeProfit is on the wrong side of the mark', 'trade.protection_wrong_side', 400);
          },
        },
      });
      const refused = await server.inject({ method: 'POST', url: '/api/v1/futures/orders', payload: { ...body, takeProfit: '60000' } });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ error: 'trade.protection_wrong_side' });
      expect(placed).toBe(0);
      const plain = await server.inject({ method: 'POST', url: '/api/v1/futures/orders', payload: body });
      expect(plain.json()).toEqual(order);
      expect(placed).toBe(1);
    });

    it('unwired is 503 with nothing placed, and the split door refuses it in words', async () => {
      let placed = 0;
      const server = await app({
        place: async () => {
          placed += 1;
          return order;
        },
        placeSplit: async () => {
          placed += 1;
          return { parts: 1, orders: [order], stopped: null };
        },
      });
      const unwired = await server.inject({ method: 'POST', url: '/api/v1/futures/orders', payload: { ...body, stopLoss: '60000' } });
      expect(unwired.statusCode).toBe(503);
      expect(unwired.json()).toMatchObject({ error: 'trade.entry_protection_unmounted' });
      const split = await server.inject({ method: 'POST', url: '/api/v1/futures/orders/split', payload: { ...body, takeProfit: '70000' } });
      expect(split.statusCode).toBe(400);
      expect(split.json()).toMatchObject({ error: 'trade.entry_protection_split_unsupported' });
      expect(placed).toBe(0);
    });
  });
  describe('one-tap reverse (J-derivatives-03 #9)', () => {
    const view = { clientRequestId: 'reverse:1', status: 'done' } as unknown as ReverseView;

    it('passes the position, the request id, the accepted tier, the signed account and the edge region', async () => {
      const seen: { userId: string; input: ReverseInput; region: string | null | undefined }[] = [];
      const server = await app({
        reverse: async (p, input, context) => {
          seen.push({ userId: p.userId, input, region: context.region });
          return view;
        },
      });
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/positions/pos-1/reverse',
        payload: { clientRequestId: ' reverse:1 ', confirmTier: 2 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(view);
      expect(seen).toEqual([{ userId: USER, input: { positionId: 'pos-1', clientRequestId: 'reverse:1', confirmTier: 2 }, region: 'EU' }]);
    });

    it('a missing request id or a malformed tier never reaches the service; a typed refusal keeps its code', async () => {
      let calls = 0;
      const server = await app({
        reverse: async () => {
          calls += 1;
          throw new MatchedOrderError('one-way', 'trade.futures_one_way_flip_refused', 409);
        },
      });
      const missing = await server.inject({ method: 'POST', url: '/api/v1/positions/pos-1/reverse', payload: {} });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error).toBe('trade.client_request_id_required');
      const tier = await server.inject({
        method: 'POST',
        url: '/api/v1/positions/pos-1/reverse',
        payload: { clientRequestId: 'r', confirmTier: '2' },
      });
      expect(tier.json().error).toBe('trade.confirm_tier_invalid');
      expect(calls).toBe(0);
      const refused = await server.inject({ method: 'POST', url: '/api/v1/positions/pos-1/reverse', payload: { clientRequestId: 'r' } });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toBe('trade.futures_one_way_flip_refused');
    });

    it('unwired is 503, signed out 401, and the jurisdiction gate holds it back', async () => {
      const unwired = await (
        await app({})
      ).inject({ method: 'POST', url: '/api/v1/positions/p/reverse', payload: { clientRequestId: 'r' } });
      expect(unwired.statusCode).toBe(503);
      const reverse = async () => view;
      expect(
        (await (await app({ reverse }, { signedIn: false })).inject({ method: 'POST', url: '/api/v1/positions/p/reverse' })).statusCode,
      ).toBe(401);
      expect(
        (await (await app({ reverse }, { jurisdiction: false })).inject({ method: 'POST', url: '/api/v1/positions/p/reverse' })).statusCode,
      ).toBe(403);
    });
  });
});
