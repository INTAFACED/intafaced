import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { fakeOrder, registerPrivateRest, type PrivateRestDeps } from '../private-rest.js';
import { fakeMarket } from '../public-rest.js';
import type { PlaceOrderInput } from './trade-service.js';

/**
 * OCO and bracket are accepted on the create door only; replace and batch refuse them.
 */

const SECRET = 'a-trade-bracket-oco-parked-edge-secret-long-x';
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

describe('OCO and bracket have the create door only', () => {
  it('OCO on the create door reaches placeOrder carrying its legs', async () => {
    const { app, placed } = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: signed(),
      payload: { ...BASE, side: 'sell', oco: true, takeProfit: '110', stopLoss: '90' },
    });
    expect(res.statusCode).toBe(201);
    expect(placed).toHaveLength(1);
    await app.close();
  });

  it('a bracket on the create door reaches placeOrder; svc-trade places the exit after the entry fills', async () => {
    const { app, placed } = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: signed(),
      payload: { ...BASE, bracket: true, takeProfit: '110', stopLoss: '90' },
    });
    expect(res.statusCode).toBe(201);
    expect(placed).toHaveLength(1);
    expect(placed[0]?.clientOrderId).toBe('b-1');
    expect(placed[0]?.side).toBe('buy');
    await app.close();
  });

  it('a bracket in a batch item is refused per item and the plain item is still placed', async () => {
    const { app, placed } = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/batch',
      headers: signed(),
      payload: {
        orders: [
          { ...BASE, clientOrderId: 'b-4', bracket: true, takeProfit: '110', stopLoss: '90' },
          { ...BASE, clientOrderId: 'b-5' },
        ],
      },
    });
    const results = res.json().results as Array<{ status: string; error?: { intafacedCode?: string } }>;
    expect(results[0]).toMatchObject({ status: 'refused', error: { intafacedCode: 'trade.order_type_unsupported' } });
    expect(results[1]?.status).not.toBe('refused');
    expect(placed.map((p) => p.clientOrderId)).toEqual(['b-5']);
    await app.close();
  });

  it('a batch item with OCO legs is refused per item and the plain item is still placed', async () => {
    const { app, placed } = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/batch',
      headers: signed(),
      payload: {
        orders: [
          { ...BASE, clientOrderId: 'b-2', oco: true, takeProfit: '110', stopLoss: '90' },
          { ...BASE, clientOrderId: 'b-3' },
        ],
      },
    });
    const results = res.json().results as Array<{ status: string; error?: { intafacedCode?: string } }>;
    expect(results[0]).toMatchObject({ status: 'refused', error: { intafacedCode: 'trade.order_type_unsupported' } });
    expect(results[1]?.status).not.toBe('refused');
    expect(placed.map((p) => p.clientOrderId)).toEqual(['b-3']);
    await app.close();
  });

  it('a plain order is still placed', async () => {
    const { app, placed } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/v1/orders', headers: signed(), payload: BASE });
    expect(res.statusCode).toBe(201);
    expect(placed).toHaveLength(1);
    await app.close();
  });
});
