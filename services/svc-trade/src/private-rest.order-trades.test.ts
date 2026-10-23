/**
 * Private REST: GET /api/v1/orders/:id/trades lists one of the caller's orders' fills (CCXT fetchOrderTrades), each with
 * its role, fee, fee asset and fee rate. Another person's order and a malformed id are not found; the limit is required.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { fakeMarket } from './public-rest.js';
import { registerPrivateRest, type PrivateRestDeps } from './private-rest.js';
import { TradeError, type FillRecord } from './spot/types.js';

const SECRET = 'a-trade-private-rest-order-trades-edge-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const MINE = '44444444-4444-4444-8444-444444444444';
const THEIRS = '55555555-5555-4555-8555-555555555555';

function signedHeaders(): Record<string, string> {
  const p = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read'],
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

const market = fakeMarket({ symbol: 'BTC/USDT' });
const fill = (over: Partial<FillRecord>): FillRecord => ({
  id: 'f1',
  orderId: MINE,
  counterOrderId: THEIRS,
  marketId: market.id,
  userId: USER,
  side: 'buy',
  liquidity: 'taker',
  price: amt('100'),
  qty: amt('0.5'),
  quoteAmount: amt('50'),
  feeAsset: 'BTC',
  feeAmount: amt('0.0005'),
  feeBps: 10,
  sequence: 1,
  ts: new Date(1_000),
  sessionId: null,
  apiKeyId: null,
  ...over,
});

async function get(url: string, orderFills: PrivateRestDeps['orderFills'] | undefined) {
  const calls: Array<[string, number]> = [];
  const app = Fastify({ logger: false });
  registerPrivateRest(app, {
    edgeSecret: SECRET,
    serviceName: 'svc-trade',
    ...(orderFills
      ? {
          orderFills: async (p: Principal, id: string, limit: number) => {
            calls.push([id, limit]);
            return orderFills(p, id, limit);
          },
        }
      : {}),
    marketBySymbol: async () => market,
    marketById: async (id: string) => (id === market.id ? market : null),
  } as unknown as PrivateRestDeps);
  await app.ready();
  const res = await app.inject({ method: 'GET', url, headers: signedHeaders() });
  await app.close();
  return { res, calls };
}

const fills: PrivateRestDeps['orderFills'] = async (_p, id) => {
  if (id !== MINE) throw new TradeError('order not found', 'trade.order_not_found');
  return [fill({}), fill({ id: 'f2', liquidity: 'maker', price: amt('101'), quoteAmount: amt('50.5'), feeBps: 5, sequence: 2 })];
};

describe('GET /api/v1/orders/:id/trades', () => {
  it('lists the order’s fills with role, fee, fee asset and rate', async () => {
    const { res, calls } = await get(`/api/v1/orders/${MINE}/trades?limit=50`, fills);
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([[MINE, 50]]);
    const rows = res.json();
    expect(rows.map((r: { id: string }) => r.id)).toEqual(['f1', 'f2']);
    expect(rows[0]).toMatchObject({
      order: MINE,
      symbol: 'BTC/USDT',
      takerOrMaker: 'taker',
      price: '100',
      amount: '0.5',
      cost: '50',
      fee: { cost: '0.0005', currency: 'BTC', rate: '0.001' },
    });
    expect(rows[1]).toMatchObject({ takerOrMaker: 'maker', fee: { rate: '0.0005' } });
  });

  it('answers another person’s order and a malformed id as not found', async () => {
    const theirs = await get(`/api/v1/orders/${THEIRS}/trades?limit=50`, fills);
    expect(theirs.res.statusCode).toBe(404);
    expect(theirs.res.json().code).toBe('OrderNotFound');
    const malformed = await get('/api/v1/orders/not-an-id/trades?limit=50', fills);
    expect(malformed.res.statusCode).toBe(404);
    expect(malformed.res.json().code).toBe('OrderNotFound');
    expect(malformed.calls).toEqual([]);
  });

  it('refuses a missing or out-of-range limit before reading', async () => {
    for (const q of ['', '?limit=0', '?limit=abc', '?limit=100000']) {
      const { res, calls } = await get(`/api/v1/orders/${MINE}/trades${q}`, fills);
      expect(res.statusCode, q).toBe(400);
      expect(calls, q).toEqual([]);
    }
  });

  it('answers a typed 503 when the fills read is not configured', async () => {
    const { res } = await get(`/api/v1/orders/${MINE}/trades?limit=50`, undefined);
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('trade.order_fills_unconfigured');
  });
});
