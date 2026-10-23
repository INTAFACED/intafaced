import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { parseAmount } from '@intafaced/ledger-client';
import { attachMatchedOrderRoutes, readPlaceBody, type FuturesOrderWire, type MatchedOrdersRestDeps } from './matched-orders-rest.js';
import { MatchedOrderError, type PlaceMatchedOrderInput } from './matched-orders.js';

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
        return { parts: 2, orders: children };
      },
    });
    const res = await server.inject({ method: 'POST', url: '/api/v1/futures/orders/split', payload: { ...body, priceCorrection: 'adjust' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ parts: 2, orders: children });
    expect(seen[0]).toMatchObject({ clientOrderId: 'desk-1', qty: parseAmount('0.01'), priceCorrection: 'adjust' });
    // A malformed body never reaches the service; an unwired split door is 503.
    expect((await server.inject({ method: 'POST', url: '/api/v1/futures/orders/split', payload: { ...body, amount: 1 } })).statusCode).toBe(400);
    expect(seen).toHaveLength(1);
    const bare = await app({ place: async () => order });
    const unwired = await bare.inject({ method: 'POST', url: '/api/v1/futures/orders/split', payload: body });
    expect(unwired.statusCode).toBe(503);
    const out = await app({ placeSplit: async () => ({ parts: 1, orders: [order] }) }, { jurisdiction: false });
    expect((await out.inject({ method: 'POST', url: '/api/v1/futures/orders/split', payload: body })).statusCode).toBe(403);
  });

  it('signed out is 401 and an unwired door is 503, never a pretend order', async () => {
    const out = await app({ place: async () => order }, { signedIn: false });
    expect((await out.inject({ method: 'POST', url: '/api/v1/futures/orders', payload: body })).statusCode).toBe(401);
    const bare = await app({});
    const res = await bare.inject({ method: 'GET', url: '/api/v1/futures/orders?scope=open&limit=5' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('trade.futures_orders_unmounted');
  });
});
