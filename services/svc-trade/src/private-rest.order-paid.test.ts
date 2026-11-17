/**
 * #4677: an order's `cost`, `average` and `fee` on the CCXT wire are what its fills paid, not the reserved ceiling.
 * A market buy reserved at its protection price showed cost = protection × filled (9.800889 against fills of
 * 9.752127); a market sell showed cost null; `average` and `fee` were always null. Every order read and POST /orders
 * now reads the order's fills once (`ordersFills`) and lays the paid sums over the estimate.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { orderSchema } from '@intafaced/exchange-contract';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { fakeMarket } from './public-rest.js';
import { fakeFill, fakeOrder, presentCcxtOrderPaid, registerPrivateRest, type PrivateRestDeps } from './private-rest.js';
import type { FillRecord, OrderRecord } from './spot/types.js';

const SECRET = 'a-trade-private-rest-order-paid-edge-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const BUY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SELL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function signedHeaders(): Record<string, string> {
  const p = {
    sub: USER,
    userId: USER,
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

const market = fakeMarket({ symbol: 'BTC/USDT' });

// The issue's live case: a $10 market buy reserved at its protection price, filled for 9.752127 in two fills.
const marketBuy = fakeOrder({
  id: BUY,
  marketId: market.id,
  side: 'buy',
  type: 'market',
  price: null,
  protectionPrice: amt('98.00889'),
  qty: amt('0.1'),
  filledQty: amt('0.1'),
  status: 'filled',
});
const buyFills: FillRecord[] = [
  fakeFill({
    id: 'b1',
    orderId: BUY,
    marketId: market.id,
    qty: amt('0.06'),
    price: amt('97.5'),
    quoteAmount: amt('5.85'),
    feeAsset: 'BTC',
    feeAmount: amt('0.00006'),
  }),
  fakeFill({
    id: 'b2',
    orderId: BUY,
    marketId: market.id,
    qty: amt('0.04'),
    price: amt('97.553175'),
    quoteAmount: amt('3.902127'),
    feeAsset: 'BTC',
    feeAmount: amt('0.00004'),
  }),
];
const marketSell = fakeOrder({
  id: SELL,
  marketId: market.id,
  side: 'sell',
  type: 'market',
  price: null,
  protectionPrice: amt('90'),
  qty: amt('0.2'),
  filledQty: amt('0.2'),
  status: 'filled',
});
const sellFills: FillRecord[] = [
  fakeFill({
    id: 's1',
    orderId: SELL,
    marketId: market.id,
    side: 'sell',
    qty: amt('0.2'),
    price: amt('99'),
    quoteAmount: amt('19.8'),
    feeAsset: 'USDT',
    feeAmount: amt('0.0198'),
  }),
];
const ALL = new Map<string, FillRecord[]>([
  [BUY, buyFills],
  [SELL, sellFills],
]);

type Reader = PrivateRestDeps['ordersFills'];
const reader: Reader = async (_p, ids) => new Map(ids.filter((id) => ALL.has(id)).map((id) => [id, ALL.get(id)!]));

async function inject(method: 'GET' | 'POST', url: string, opts: { ordersFills?: Reader; orders?: OrderRecord[]; payload?: object } = {}) {
  const orders = opts.orders ?? [marketBuy, marketSell];
  const reads: string[][] = [];
  const app = Fastify({ logger: false });
  registerPrivateRest(app, {
    edgeSecret: SECRET,
    serviceName: 'svc-trade',
    ...(opts.ordersFills
      ? {
          ordersFills: async (p: Principal, ids: readonly string[]) => {
            reads.push([...ids]);
            return opts.ordersFills!(p, ids);
          },
        }
      : {}),
    getOrder: async (_p: Principal, id: string) => orders.find((o) => o.id === id)!,
    openOrders: async () => orders,
    orderHistory: async () => orders,
    placeOrder: async () => orders[0]!,
    marketBySymbol: async () => market,
    marketById: async (id: string) => (id === market.id ? market : null),
  } as unknown as PrivateRestDeps);
  await app.ready();
  const res = await app.inject({
    method,
    url,
    headers: { ...signedHeaders(), ...(opts.payload ? { 'content-type': 'application/json' } : {}) },
    ...(opts.payload ? { payload: opts.payload } : {}),
  });
  await app.close();
  return { res, reads };
}

describe('order cost, average and fee are what the fills paid (#4677)', () => {
  it('GET /orders/:id: a market buy costs the fills, not protection price × filled', async () => {
    const { res, reads } = await inject('GET', `/api/v1/orders/${BUY}`, { ordersFills: reader });
    expect(res.statusCode).toBe(200);
    const wire = res.json();
    expect(reads).toEqual([[BUY]]);
    expect(wire.cost).toBe('9.752127');
    expect(wire.cost).not.toBe('9.800889'); // the reserved ceiling the issue saw
    expect(wire.average).toBe('97.52127');
    expect(wire.fee).toEqual({ cost: '0.0001', currency: 'BTC' });
    expect(wire.fees).toEqual([{ cost: '0.0001', currency: 'BTC' }]);
    expect(orderSchema.safeParse(wire).success).toBe(true);
  });

  it('GET /orders/:id: a market sell states its proceeds, average and fee, never null', async () => {
    const { res } = await inject('GET', `/api/v1/orders/${SELL}`, { ordersFills: reader });
    const wire = res.json();
    expect(wire.cost).toBe('19.8');
    expect(wire.average).toBe('99');
    expect(wire.fee).toEqual({ cost: '0.0198', currency: 'USDT' });
  });

  it('GET /orders/open and /orders/closed read every filled order’s fills in one read', async () => {
    for (const url of ['/api/v1/orders/open?limit=10', '/api/v1/orders/closed?limit=10']) {
      const { res, reads } = await inject('GET', url, { ordersFills: reader });
      expect(res.statusCode, url).toBe(200);
      expect(reads, url).toEqual([[BUY, SELL]]);
      const rows = res.json() as Array<{ id: string; cost: string | null; average: string | null }>;
      expect(
        rows.map((r) => [r.id, r.cost, r.average]),
        url,
      ).toEqual([
        [BUY, '9.752127', '97.52127'],
        [SELL, '19.8', '99'],
      ]);
    }
  });

  it('POST /orders: a market buy that filled answers with what it paid', async () => {
    const { res } = await inject('POST', '/api/v1/orders', {
      ordersFills: reader,
      orders: [marketBuy],
      payload: { symbol: 'BTC/USDT', type: 'market', side: 'buy', amount: '0.1', clientOrderId: 'paid-buy' },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ cost: '9.752127', average: '97.52127', fee: { cost: '0.0001', currency: 'BTC' } });
  });

  it('a failed fills read states nothing: cost, average and fee null, never the ceiling', async () => {
    const failing: Reader = async () => {
      throw new Error('db down');
    };
    const { res } = await inject('GET', `/api/v1/orders/${BUY}`, { ordersFills: failing });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ cost: null, average: null, fee: null, fees: null });
  });

  it('an unfilled order needs no read and costs "0"', async () => {
    const resting = fakeOrder({ id: BUY, marketId: market.id });
    const { res, reads } = await inject('GET', `/api/v1/orders/${BUY}`, { ordersFills: reader, orders: [resting] });
    expect(reads).toEqual([]);
    expect(res.json()).toMatchObject({ cost: '0', average: null, fee: null });
  });
});

describe('presentCcxtOrderPaid', () => {
  it('fills that do not add up to the filled quantity state nothing, never a partial sum', () => {
    expect(presentCcxtOrderPaid(marketBuy, [buyFills[0]!])).toEqual({ cost: null, average: null, fee: null, fees: null });
    expect(presentCcxtOrderPaid(marketBuy, [])).toEqual({ cost: null, average: null, fee: null, fees: null });
  });

  it('fees in more than one asset: fee null, each asset’s sum in fees', () => {
    const mixed = [buyFills[0]!, { ...buyFills[1]!, feeAsset: 'IFC', feeAmount: amt('0.5') }];
    const paid = presentCcxtOrderPaid(marketBuy, mixed);
    expect(paid.cost).toBe('9.752127');
    expect(paid.fee).toBeNull();
    expect(paid.fees).toEqual([
      { cost: '0.00006', currency: 'BTC' },
      { cost: '0.5', currency: 'IFC' },
    ]);
  });
});
