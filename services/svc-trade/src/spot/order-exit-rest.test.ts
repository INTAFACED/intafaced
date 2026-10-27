import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { orderSchema } from '@intafaced/exchange-contract';
import { fakeOrder, registerPrivateRest, type OcoExitLegs, type PrivateRestDeps } from '../private-rest.js';
import type { OrderLink } from './order-links.js';
import { fakeMarket } from '../public-rest.js';

/**
 * The orders API marks an OCO parent and a bracket's exit with their linked legs, and an OTO entry and its close with
 * each other, so the desk can show them.
 */

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

describe('OTO link', () => {
  const entry = fakeOrder({ id: 'o-oto', userId: ALICE, marketId: market.id, clientOrderId: 'oto-1' });
  const close = fakeOrder({ id: 'o-close', userId: ALICE, marketId: market.id, clientOrderId: 'oto:o-oto:close', side: 'sell' });
  const plain = fakeOrder({ id: 'o-plain', userId: ALICE, marketId: market.id, clientOrderId: 'plain-1' });
  const LINKS = new Map<string, OrderLink>([
    ['o-oto', { role: 'entry', closePrice: '110', closeOrderId: 'o-close' }],
    ['o-close', { role: 'close', entryOrderId: 'o-oto' }],
  ]);

  async function buildLinked() {
    const all = [entry, close, plain];
    const app = Fastify();
    registerPrivateRest(app, {
      edgeSecret: SECRET,
      serviceName: 'svc-trade',
      orderLinks: async (ids: readonly string[]) => new Map(ids.flatMap((i) => (LINKS.has(i) ? [[i, LINKS.get(i)!] as const] : []))),
      marketById: async () => market,
      marketBySymbol: async () => market,
      openOrders: async () => all,
      getOrder: async (_p: Principal, id: string) => all.find((o) => o.id === id)!,
      placeOrder: async () => entry,
    } as unknown as PrivateRestDeps);
    await app.ready();
    return app;
  }

  it('links an OTO entry and its close on reads, leaves a plain order alone, and the wire parses as an order', async () => {
    const app = await buildLinked();
    const res = await app.inject({ method: 'GET', url: '/api/v1/orders/open?limit=50', headers: signed(ALICE) });
    const byId = new Map((res.json() as Array<{ id: string; linked?: unknown }>).map((o) => [o.id, o]));
    expect(byId.get('o-oto')?.linked).toEqual({ role: 'entry', closePrice: '110', closeOrderId: 'o-close' });
    expect(byId.get('o-close')?.linked).toEqual({ role: 'close', entryOrderId: 'o-oto' });
    expect(byId.get('o-plain')?.linked).toBeUndefined();
    const got = await app.inject({ method: 'GET', url: '/api/v1/orders/o-close', headers: signed(ALICE) });
    expect(orderSchema.safeParse(got.json()).success).toBe(true);
    expect(orderSchema.parse(got.json()).linked).toEqual({ role: 'close', entryOrderId: 'o-oto' });
  });

  it('answers the placement of an OTO entry with its stored close', async () => {
    const app = await buildLinked();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { ...signed(ALICE), 'content-type': 'application/json' },
      payload: {
        symbol: 'BTC/USDT',
        type: 'limit',
        side: 'buy',
        amount: '1',
        price: '100',
        clientOrderId: 'oto-1',
        oto: true,
        close: { price: '110' },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().linked).toEqual({ role: 'entry', closePrice: '110', closeOrderId: 'o-close' });
  });
});
