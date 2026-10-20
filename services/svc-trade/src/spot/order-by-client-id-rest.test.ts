import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { fakeOrder, registerPrivateRest, type PrivateRestDeps } from '../private-rest.js';
import { fakeMarket } from '../public-rest.js';
import { orderIdFor } from './ids.js';

/** An API trader keeps its own client ids, not ours: read and cancel an order by the clientOrderId it placed. */

const SECRET = 'a-trade-by-client-id-edge-secret-long-enough-x';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '33333333-3333-4333-8333-333333333333';
const market = fakeMarket({ id: 'm-btc', symbol: 'BTC/USDT' });

function signed(userId: string, scopes = ['trade:read', 'trade:write']): Record<string, string> {
  const p = {
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
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

async function build() {
  const cancelled: string[] = [];
  const aliceOrder = fakeOrder({ id: orderIdFor(ALICE, market.id, 'mine-1'), userId: ALICE, marketId: market.id, clientOrderId: 'mine-1' });
  const app = Fastify();
  registerPrivateRest(app, {
    edgeSecret: SECRET,
    serviceName: 'svc-trade',
    marketBySymbol: async (s: string) => (s === 'BTC/USDT' ? market : null),
    marketById: async () => market,
    findClientOrder: async (p: Principal, input: { marketId?: string; symbol?: string; clientOrderId?: string }) =>
      input.symbol === 'BTC/USDT' && input.clientOrderId === 'mine-1' && p.userId === ALICE ? aliceOrder : null,
    getOrder: async () => aliceOrder,
    cancelOrder: async (_p: Principal, id: string) => {
      cancelled.push(id);
      return { ...aliceOrder, status: 'cancelled' } as typeof aliceOrder;
    },
  } as unknown as PrivateRestDeps);
  await app.ready();
  return { app, cancelled, aliceOrder };
}

describe('orders by clientOrderId', () => {
  it('reads the order the caller placed under that client id', async () => {
    const { app, aliceOrder } = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/orders/by-client-id/mine-1?symbol=BTC%2FUSDT', headers: signed(ALICE) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id: aliceOrder.id, clientOrderId: 'mine-1', symbol: 'BTC/USDT' });
  });

  it('cancels it by the client id, through the same cancel as by id', async () => {
    const { app, cancelled, aliceOrder } = await build();
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/orders/by-client-id/mine-1?symbol=BTC%2FUSDT', headers: signed(ALICE) });
    expect(res.statusCode, res.body).toBe(200);
    expect(cancelled).toEqual([aliceOrder.id]);
  });

  it('answers on the shorter by-client path too, and never shows another caller the order', async () => {
    const { app, cancelled, aliceOrder } = await build();
    const read = await app.inject({ method: 'GET', url: '/api/v1/orders/by-client/mine-1?symbol=BTC%2FUSDT', headers: signed(ALICE) });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({ id: aliceOrder.id, clientOrderId: 'mine-1' });
    const other = await app.inject({ method: 'GET', url: '/api/v1/orders/by-client/mine-1?symbol=BTC%2FUSDT', headers: signed(BOB) });
    expect(other.statusCode).toBe(404);
    const cancel = await app.inject({ method: 'DELETE', url: '/api/v1/orders/by-client/mine-1?symbol=BTC%2FUSDT', headers: signed(ALICE) });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(cancelled).toEqual([aliceOrder.id]);
  });

  it('answers not found for an unknown client id and for someone else’s, and cancels nothing', async () => {
    const { app, cancelled } = await build();
    const unknown = await app.inject({
      method: 'DELETE',
      url: '/api/v1/orders/by-client-id/nope?symbol=BTC%2FUSDT',
      headers: signed(ALICE),
    });
    expect(unknown.statusCode).toBe(404);
    const other = await app.inject({ method: 'DELETE', url: '/api/v1/orders/by-client-id/mine-1?symbol=BTC%2FUSDT', headers: signed(BOB) });
    expect(other.statusCode).toBe(404);
    expect(cancelled).toEqual([]);
  });

  it('needs the symbol, because a client id is only unique per market', async () => {
    const { app, cancelled } = await build();
    const none = await app.inject({ method: 'DELETE', url: '/api/v1/orders/by-client-id/mine-1', headers: signed(ALICE) });
    expect(none.statusCode).toBe(400);
    const badSymbol = await app.inject({
      method: 'GET',
      url: '/api/v1/orders/by-client-id/mine-1?symbol=NOPE%2FUSDT',
      headers: signed(ALICE),
    });
    expect(badSymbol.statusCode).toBe(404);
    expect(badSymbol.json().intafacedCode).toBe('trade.market_not_found');
    expect(cancelled).toEqual([]);
  });

  it('a read-only key may read but not cancel', async () => {
    const { app, cancelled } = await build();
    const read = await app.inject({
      method: 'GET',
      url: '/api/v1/orders/by-client-id/mine-1?symbol=BTC%2FUSDT',
      headers: signed(ALICE, ['trade:read']),
    });
    expect(read.statusCode).toBe(200);
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/v1/orders/by-client-id/mine-1?symbol=BTC%2FUSDT',
      headers: signed(ALICE, ['trade:read']),
    });
    expect(del.statusCode).toBe(403);
    expect(cancelled).toEqual([]);
  });
});
