import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { fakeOrder, registerPrivateRest, type PrivateRestDeps } from '../private-rest.js';
import { fakeMarket } from '../public-rest.js';
import type { PlaceOrderInput } from './trade-service.js';

/**
 * A trailing stop walks with a mark that only the server may supply. The create door must not accept a `trail` or a
 * `mark` from a request body: the engine would trigger a stop at a price the caller chose, and a buy would reach the
 * book as a market order funded only at its stated limit.
 */

const SECRET = 'a-trade-trailing-client-refused-edge-secret-long-x';
const ALICE = '11111111-1111-4111-8111-111111111111';
const market = fakeMarket({ id: 'm-btc', symbol: 'BTC/USDT' });

function signed(): Record<string, string> {
  const p = {
    sub: ALICE,
    userId: ALICE,
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
    'content-type': 'application/json',
  };
}

const BASE = { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '1', price: '100', clientOrderId: 'b-1' };

async function build() {
  const placed: PlaceOrderInput[] = [];
  const app = Fastify();
  registerPrivateRest(app, {
    edgeSecret: SECRET,
    serviceName: 'svc-trade',
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
        tif: input.tif ?? 'GTC',
      });
    },
  } as unknown as PrivateRestDeps);
  await app.ready();
  return { app, placed };
}

describe('the create door refuses a trailing stop whose mark the caller supplied', () => {
  it.each([
    ['a trail and a mark', { trail: '5', mark: '100' }],
    ['a trail alone', { trail: '5' }],
    ['a mark alone', { mark: '100' }],
    ['a trail of a JSON number', { trail: 5, mark: '100' }],
    ['a null trail', { trail: null, mark: '100' }],
  ])('refuses %s before any order or hold is made', async (_name, extra) => {
    const { app, placed } = await build();
    for (const side of ['buy', 'sell']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/orders',
        headers: signed(),
        payload: { ...BASE, side, clientOrderId: `t-${side}`, ...extra },
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().code ?? res.json().error).toBe('InvalidOrder'); // ccxt-errors maps trade.order_type_unsupported to InvalidOrder / 400
      expect(res.body).toContain('trailing stops are not accepted yet');
    }
    expect(placed).toHaveLength(0);
    await app.close();
  });

  it('an ordinary limit order is still accepted', async () => {
    const { app, placed } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/v1/orders', headers: signed(), payload: BASE });
    expect(res.statusCode, res.body).toBe(201);
    expect(placed).toHaveLength(1);
    await app.close();
  });
});
