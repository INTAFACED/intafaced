import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { orderSchema } from '@intafaced/exchange-contract';
import { fakeOrder, registerPrivateRest, type OcoExitLegs, type PrivateRestDeps } from '../private-rest.js';
import { fakeMarket } from '../public-rest.js';

/** The orders API marks an OCO parent and a bracket's exit with their linked legs, so the desk can show them. */

const SECRET = 'a-trade-order-exit-edge-secret-long-enough-x';
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

const LEGS: OcoExitLegs = { takeProfit: '110', stopLoss: '90', stopLossLimit: null };

async function build(withStore: boolean) {
  const oco = fakeOrder({ id: 'o-oco', userId: ALICE, marketId: market.id, clientOrderId: 'oco-1' });
  const exit = fakeOrder({ id: 'o-exit', userId: ALICE, marketId: market.id, clientOrderId: 'bracket:o-entry:exit' });
  const plain = fakeOrder({ id: 'o-plain', userId: ALICE, marketId: market.id, clientOrderId: 'plain-1' });
  const all = [oco, exit, plain];
  const app = Fastify();
  registerPrivateRest(app, {
    edgeSecret: SECRET,
    serviceName: 'svc-trade',
    ocoExits: withStore
      ? async (ids: readonly string[]) => new Map(ids.filter((i) => i !== 'o-plain').map((i) => [i, LEGS] as const))
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

describe('order exit marker', () => {
  it('marks an OCO parent and a bracket exit on open orders, and leaves a plain order alone', async () => {
    const app = await build(true);
    const res = await app.inject({ method: 'GET', url: '/api/v1/orders/open?limit=50', headers: signed(ALICE) });
    const byId = new Map((res.json() as Array<{ id: string; exit?: unknown }>).map((o) => [o.id, o]));
    expect(byId.get('o-oco')?.exit).toEqual({ kind: 'oco', ...LEGS });
    expect(byId.get('o-exit')?.exit).toEqual({ kind: 'bracket_exit', ...LEGS });
    expect(byId.get('o-plain')?.exit).toBeUndefined();
  });

  it('marks the single-order read and the cancel reply, and the wire still parses as an order', async () => {
    const app = await build(true);
    const got = await app.inject({ method: 'GET', url: '/api/v1/orders/o-oco', headers: signed(ALICE) });
    expect(got.json().exit).toEqual({ kind: 'oco', ...LEGS });
    const del = await app.inject({ method: 'DELETE', url: '/api/v1/orders/o-exit', headers: signed(ALICE) });
    expect(del.json().exit).toEqual({ kind: 'bracket_exit', ...LEGS });
    const closed = await app.inject({ method: 'GET', url: '/api/v1/orders/closed?limit=50', headers: signed(ALICE) });
    expect((closed.json() as Array<{ id: string; exit?: unknown }>).find((o) => o.id === 'o-oco')?.exit).toEqual({ kind: 'oco', ...LEGS });
    expect(orderSchema.shape.exit.safeParse(got.json().exit).success).toBe(true);
  });

  it('leaves orders unmarked when no store is wired', async () => {
    const app = await build(false);
    const res = await app.inject({ method: 'GET', url: '/api/v1/orders/o-oco', headers: signed(ALICE) });
    expect(res.json().exit).toBeUndefined();
  });
});
