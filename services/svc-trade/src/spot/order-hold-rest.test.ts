import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { orderSchema } from '@intafaced/exchange-contract';
import { fakeOrder, registerPrivateRest, type PrivateRestDeps } from '../private-rest.js';
import { fakeMarket } from '../public-rest.js';
import type { OrderHold } from './order-holds.js';

/** The orders API says what each live order still holds, so the open-orders table can show it beside the order. */

const SECRET = 'a-trade-order-hold-edge-secret-long-enough-xx';
const ALICE = '11111111-1111-4111-8111-111111111111';
const market = fakeMarket({ id: 'm-btc', symbol: 'BTC/USDT' });

function signed(userId: string): Record<string, string> {
  const p = {
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read', 'trade:write'],
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

const HOLD: OrderHold = { asset: 'USDT', amount: '128.0512' };

async function build(withHolds: boolean) {
  const live = fakeOrder({ id: 'o-live', userId: ALICE, marketId: market.id, clientOrderId: 'live-1' });
  const closed = fakeOrder({ id: 'o-closed', userId: ALICE, marketId: market.id, clientOrderId: 'closed-1', status: 'cancelled' });
  const all = [live, closed];
  const app = Fastify();
  registerPrivateRest(app, {
    edgeSecret: SECRET,
    serviceName: 'svc-trade',
    orderHolds: withHolds
      ? async (orders: readonly { id: string }[]) => new Map(orders.filter((o) => o.id === 'o-live').map((o) => [o.id, HOLD] as const))
      : undefined,
    marketById: async () => market,
    openOrders: async () => all,
    orderHistory: async () => all,
    getOrder: async (_p: Principal, id: string) => all.find((o) => o.id === id)!,
    cancelOrder: async (_p: Principal, id: string) => all.find((o) => o.id === id)!,
  } as unknown as PrivateRestDeps);
  await app.ready();
  return app;
}

describe('order hold on the wire', () => {
  it('a live order carries its hold; an order the store states nothing for carries null', async () => {
    const app = await build(true);
    const res = await app.inject({ method: 'GET', url: '/api/v1/orders/open?limit=50', headers: signed(ALICE) });
    const byId = new Map((res.json() as Array<{ id: string; hold?: unknown }>).map((o) => [o.id, o]));
    expect(byId.get('o-live')?.hold).toEqual(HOLD);
    expect(byId.get('o-closed')?.hold).toBeNull();
  });

  it('the single-order read carries it too, and the wire still parses as an order', async () => {
    const app = await build(true);
    const got = await app.inject({ method: 'GET', url: '/api/v1/orders/o-live', headers: signed(ALICE) });
    expect(got.json().hold).toEqual(HOLD);
    expect(orderSchema.safeParse(got.json()).success).toBe(true);
  });

  it('a failed hold read states nothing and the orders read still answers', async () => {
    const app = Fastify();
    const live = fakeOrder({ id: 'o-live', userId: ALICE, marketId: market.id, clientOrderId: 'live-1' });
    registerPrivateRest(app, {
      edgeSecret: SECRET,
      serviceName: 'svc-trade',
      orderHolds: async () => {
        throw new Error('fills read failed');
      },
      marketById: async () => market,
      openOrders: async () => [live],
      getOrder: async () => live,
    } as unknown as PrivateRestDeps);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/v1/orders/open?limit=50', headers: signed(ALICE) });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Array<{ hold?: unknown }>)[0]?.hold).toBeNull();
  });

  it('with no store wired, no order claims a hold either way', async () => {
    const app = await build(false);
    const res = await app.inject({ method: 'GET', url: '/api/v1/orders/o-live', headers: signed(ALICE) });
    expect(res.json()).not.toHaveProperty('hold');
  });
});
