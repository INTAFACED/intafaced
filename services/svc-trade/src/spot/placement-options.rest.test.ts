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

async function build() {
  const placed: PlaceOrderInput[] = [];
  const app = Fastify();
  registerPrivateRest(app, {
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
  return { app, placed };
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
});
