import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { fakeOrder, registerPrivateRest, type PrivateRestDeps } from '../private-rest.js';
import { fakeMarket } from '../public-rest.js';
import type { PlaceOrderInput } from './trade-service.js';

/** The create door refuses a spent deadline, an unsupported self-trade mode and a tag before any order or hold. */

const SECRET = 'a-trade-placement-options-edge-secret-long-xxxx';
const ALICE = '11111111-1111-4111-8111-111111111111';
const market = fakeMarket({ id: 'm-btc', symbol: 'BTC/USDT' });
const NOW = new Date('2026-10-20T12:00:00.000Z');

function signed(): Record<string, string> {
  const p = {
    sub: ALICE,
    userId: ALICE,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(NOW.getTime() + 60_000),
  } as Principal;
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
    'content-type': 'application/json',
  };
}

const BASE = { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '1', price: '100', clientOrderId: 'p-1' };

async function build(existing: Set<string> = new Set(), lookup: { calls: number; fail?: boolean } = { calls: 0 }) {
  const placed: PlaceOrderInput[] = [];
  const replaced: string[] = [];
  const app = Fastify();
  registerPrivateRest(app, {
    findClientOrder: async (_p: Principal, input: { clientOrderId?: string }) => {
      lookup.calls += 1;
      if (lookup.fail) throw new Error('db down');
      return input.clientOrderId && existing.has(input.clientOrderId)
        ? fakeOrder({ marketId: market.id, clientOrderId: input.clientOrderId })
        : null;
    },
    replaceOrder: async (_p: Principal, id: string) => {
      replaced.push(id);
      throw new Error('unreachable');
    },
    edgeSecret: SECRET,
    serviceName: 'svc-trade',
    now: () => NOW,
    marketBySymbol: async (s: string) => (s === 'BTC/USDT' ? market : null),
    marketById: async (id: string) => (id === market.id ? market : null),
    placeOrder: async (_p: Principal, input: PlaceOrderInput) => {
      placed.push(input);
      return fakeOrder({
        marketId: market.id,
        clientOrderId: input.clientOrderId,
        side: input.side,
        type: 'limit',
        price: input.price,
        qty: input.qty,
      });
    },
  } as unknown as PrivateRestDeps);
  await app.ready();
  return { app, placed, replaced };
}

describe('the create door and the options spot does not act on', () => {
  it.each([
    ['a deadline in the past', { requestDeadline: '2026-10-20T11:59:00.000Z' }, 'the request deadline has passed'],
    ['a self-trade mode the engine does not run', { stpMode: 'cancel_both' }, 'is not supported'],
    ['a tag', { tag: 'desk-1' }, 'order tags are not stored yet'],
  ])('refuses %s before any order is placed', async (_name, extra, text) => {
    const { app, placed } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/v1/orders', headers: signed(), payload: { ...BASE, ...extra } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toContain(text);
    expect(placed).toHaveLength(0);
    await app.close();
  });

  it('accepts a future deadline and the engine self-trade mode', async () => {
    const { app, placed } = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: signed(),
      payload: { ...BASE, requestDeadline: '2026-10-20T12:00:30.000Z', stpMode: 'cancel_maker' },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(placed).toHaveLength(1);
    await app.close();
  });

  it('does not refuse an already-booked order as expired: a replay returns the order that exists', async () => {
    const { app, placed } = await build(new Set(['p-1']));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: signed(),
      payload: { ...BASE, requestDeadline: '2026-10-20T11:59:00.000Z' },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(placed).toHaveLength(1);
    await app.close();
  });

  it('reads no booked order for a request with no spent deadline, so a lookup failure cannot touch it', async () => {
    const lookup = { calls: 0, fail: true };
    const { app, placed } = await build(new Set(), lookup);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: signed(),
      payload: { ...BASE, requestDeadline: '2026-10-20T12:00:30.000Z' },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(lookup.calls).toBe(0);
    expect(placed).toHaveLength(1);
    await app.close();
  });

  it('replays a booked item on the batch door instead of refusing it as expired', async () => {
    const { app, placed } = await build(new Set(['b-1']));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/batch',
      headers: signed(),
      payload: { orders: [{ ...BASE, clientOrderId: 'b-1', requestDeadline: '2026-10-20T11:59:00.000Z' }] },
    });
    const results = res.json().results as Array<{ status: string; error?: unknown }>;
    expect(results[0]?.error).toBeUndefined();
    expect(placed).toHaveLength(1);
    await app.close();
  });

  it('refuses the same options per item on the batch door, and places the rest', async () => {
    const { app, placed } = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/batch',
      headers: signed(),
      payload: {
        orders: [
          { ...BASE, clientOrderId: 'b-1', requestDeadline: '2026-10-20T11:59:00.000Z' },
          { ...BASE, clientOrderId: 'b-2', stpMode: 'cancel_both' },
          { ...BASE, clientOrderId: 'b-3', tag: 'x' },
          { ...BASE, clientOrderId: 'b-4' },
        ],
      },
    });
    const results = res.json().results as Array<{ status: string; error?: { intafacedCode?: string } }>;
    expect(results.map((r) => r.error?.intafacedCode)).toEqual([
      'trade.request_expired',
      'trade.stp_mode_unsupported',
      'trade.tag_unsupported',
      undefined,
    ]);
    expect(placed.map((p) => p.clientOrderId)).toEqual(['b-4']);
    await app.close();
  });

  it.each([
    ['a deadline', { requestDeadline: '2026-10-20T12:30:00.000Z' }],
    ['a self-trade mode', { stpMode: 'cancel_maker' }],
    ['a tag', { tag: 'x' }],
  ])('the replace door takes no %s and cancels nothing', async (_name, extra) => {
    const { app, replaced } = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/33333333-3333-4333-8333-333333333333/replace',
      headers: signed(),
      payload: { ...BASE, clientOrderId: 'r-1', ...extra },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toContain('a replacement does not take');
    expect(replaced).toHaveLength(0);
    await app.close();
  });
});
