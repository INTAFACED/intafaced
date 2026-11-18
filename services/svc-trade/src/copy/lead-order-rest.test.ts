/**
 * A listed lead's web order with the Lead trade switch, at the create door (J-copy-bots-otc-04 #5 to #8): the desk names
 * the market by symbol, so the door finds the market's id and decides the lead trade under the order id the order is
 * placed with. A lead refusal answers its own code and places nothing. TEST figures only.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { fakeOrder, registerPrivateRest, type PrivateRestDeps } from '../private-rest.js';
import { fakeMarket } from '../public-rest.js';
import { orderIdFor } from '../spot/ids.js';
import type { PlaceOrderInput } from '../spot/trade-service.js';
import { CopyError } from './errors.js';
import type { LeadOrderAsk } from './lead-trading.js';

const SECRET = 'a-trade-lead-order-rest-edge-secret-long-enough-x';
const ALICE = '11111111-1111-4111-8111-111111111111';
const market = fakeMarket({ id: 'm-lead', symbol: 'USDC/USDT' });

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

const LEAD = { symbol: 'USDC/USDT', type: 'limit', side: 'buy', amount: '10', price: '1', clientOrderId: 'desk:lead-1', lead: true };

async function build(refuse?: CopyError) {
  const placed: PlaceOrderInput[] = [];
  const asked: LeadOrderAsk[] = [];
  const recorded: LeadOrderAsk[] = [];
  const leadTrading: PrivateRestDeps['leadTrading'] = {
    decide: async (_p: Principal, ask: LeadOrderAsk) => {
      asked.push(ask);
      if (refuse) throw refuse;
      return { lead: true, reason: null };
    },
    record: async (_p: Principal, ask: LeadOrderAsk) => {
      recorded.push(ask);
    },
  };
  const app = Fastify();
  registerPrivateRest(app, {
    edgeSecret: SECRET,
    serviceName: 'svc-trade',
    marketBySymbol: async (s: string) => (s === market.symbol ? market : null),
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
    leadTrading,
  } as PrivateRestDeps);
  await app.ready();
  return { app, placed, asked, recorded };
}

describe('a lead order at the create door', () => {
  it('named by symbol: decided and recorded under the order id it is placed with, then placed', async () => {
    const { app, placed, asked, recorded } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/v1/orders', headers: signed(), payload: LEAD });
    expect(res.statusCode, res.body).toBe(201);
    expect(asked.map((a) => [a.orderId, a.symbol, a.lead])).toEqual([[orderIdFor(ALICE, market.id, 'desk:lead-1'), 'USDC/USDT', true]]);
    expect(recorded).toHaveLength(1);
    expect(placed).toHaveLength(1);
    await app.close();
  });

  it('a lead refusal answers its own code and places nothing', async () => {
    const { app, placed, recorded } = await build(new CopyError('over the TEST daily buy cap', 'trade.copy_daily_buy_cap'));
    const res = await app.inject({ method: 'POST', url: '/api/v1/orders', headers: signed(), payload: LEAD });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().intafacedCode).toBe('trade.copy_daily_buy_cap');
    expect(recorded).toHaveLength(0);
    expect(placed).toHaveLength(0);
    await app.close();
  });

  it('a market no one lists refuses by name before any decision', async () => {
    const { app, placed, asked } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/v1/orders', headers: signed(), payload: { ...LEAD, symbol: 'ETH/USDT' } });
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
    expect(asked).toHaveLength(0);
    expect(placed).toHaveLength(0);
    await app.close();
  });
});
