import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { AuthError } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { balancesSchema, orderSchema, tradeSchema, tradingFeeSchema } from '@intafaced/exchange-contract';
import { parseAmount, type Balance } from '@intafaced/ledger-client';
import {
  crossMarginRefusal,
  fakeFill,
  fakeOrder,
  mapCreateOrderBody,
  parseAmendOrderBody,
  presentCcxtBalances,
  presentCcxtMyTrade,
  presentCcxtOrder,
  presentCcxtOrderCost,
  presentCcxtTradingFee,
  presentAdminFees,
  registerPrivateRest,
  suppliedPriceFields,
  toCcxtOrderStatus,
  type PrivateRestDeps,
} from './private-rest.js';
import { parseFeeScheduleJson } from './spot/fee-schedule.js';
import { TradeError } from './spot/types.js';
import type { PlaceOrderInput } from './spot/trade-service.js';
import { fakeMarket } from './public-rest.js';
import { FuturesError } from './futures/position-service.js';
import { DEFAULT_FUTURES_MARK_POLICY, acceptableForEntry } from './futures/mark-policy.js';
import { markSourceFromBook } from './futures/mark-source.js';

/**
 * Mount boundary for private CCXT REST (docs/decisions/mount-boundary.md).
 *
 * Principal arrives the way index.ts builds it — through createEdgeContext
 * over real headers — not as a Context literal. Unsigned self-asserted
 * principals must stay anonymous and never reach placeOrder / openOrders.
 */

const SECRET = 'a-trade-private-rest-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signedHeaders(p: Principal = principal(), region = 'DE'): Record<string, string> {
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, region),
    'x-intafaced-region': region,
  };
}

describe('toCcxtOrderStatus / presentCcxtOrder / presentCcxtMyTrade / fees', () => {
  it('maps internal statuses onto the CCXT order schema vocabulary', () => {
    expect(toCcxtOrderStatus('pending')).toBe('open');
    expect(toCcxtOrderStatus('open')).toBe('open');
    expect(toCcxtOrderStatus('filled')).toBe('closed');
    expect(toCcxtOrderStatus('cancelled')).toBe('canceled');
    expect(toCcxtOrderStatus('rejected')).toBe('rejected');
    expect(toCcxtOrderStatus('expired')).toBe('expired');
    expect(toCcxtOrderStatus('recovery_required')).toBe('open');
    expect(toCcxtOrderStatus('hold_unknown')).toBe('open');
  });

  it('projects unresolved execution separately from ordinary open/rejected', () => {
    const wire = presentCcxtOrder(
      fakeOrder({
        status: 'recovery_required',
        recoveryReason: 'SUBMIT_UNKNOWN',
        reconciliationKey: 'trade.order.reconcile:order:SUBMIT_UNKNOWN',
      }),
      'BTC/USDT',
    );
    expect(wire.status).toBe('open'); // legacy CCXT vocabulary
    expect(wire.recoveryRequired).toBe(true);
    expect(wire.holdUnknown).toBe(false);
    expect(wire.lifecycleState).toBe('RECOVERY_REQUIRED');
    expect(wire.executionOutcome).toMatchObject({ outcome: 'OUTCOME_UNKNOWN', state: 'SUBMIT_UNKNOWN' });
    expect(wire.executionOutcome?.reconciliationKey).toContain('trade.order.reconcile:');
  });

  it('maps hold_unknown to recoveryRequired so the customer does not send twice', () => {
    const wire = presentCcxtOrder(fakeOrder({ status: 'hold_unknown' }), 'BTC/USDT');
    expect(wire.status).toBe('open');
    expect(wire.recoveryRequired).toBe(true);
    expect(wire.holdUnknown).toBe(true);
  });

  it('presents an order that validates against orderSchema with decimal strings', () => {
    const order = fakeOrder({
      qty: parseAmount('1.5'),
      filledQty: parseAmount('0.5'),
      price: parseAmount('100'),
      tif: 'PO',
    });
    const wire = presentCcxtOrder(order, 'BTC/USDT');
    expect(orderSchema.safeParse(wire).success).toBe(true);
    expect(wire.symbol).toBe('BTC/USDT');
    expect(wire.amount).toBe('1.5');
    expect(wire.filled).toBe('0.5');
    expect(wire.remaining).toBe('1');
    expect(wire.cost).toBe('50');
    expect(wire.postOnly).toBe(true);
    expect(wire.status).toBe('open');
    expect(wire.rejectCode).toBeNull();
    expect(typeof wire.price).toBe('string');
    expect(typeof wire.amount).toBe('string');
  });

  it('filled market order cost uses protectionPrice when limit price is null (R6)', () => {
    const order = fakeOrder({
      type: 'market',
      price: null,
      protectionPrice: parseAmount('100'),
      qty: parseAmount('2'),
      filledQty: parseAmount('2'),
      status: 'filled',
    });
    const wire = presentCcxtOrder(order, 'BTC/USDT');
    expect(orderSchema.safeParse(wire).success).toBe(true);
    expect(wire.price).toBeNull();
    expect(wire.cost).toBe('200');
    expect(wire.cost).not.toBe('0');
  });

  it('filled market sell cost ignores the protection floor and is null without fills', () => {
    const order = fakeOrder({
      side: 'sell',
      type: 'market',
      price: null,
      protectionPrice: parseAmount('98'),
      filledQty: parseAmount('1'),
    });
    expect(presentCcxtOrderCost(order)).toBeNull();
    expect(presentCcxtOrderCost(order, [{ quoteAmount: parseAmount('99') }])).toBe('99');
  });

  it('filled market sell without fills: cost is null, never confident "0" (PEACE residual)', () => {
    const order = fakeOrder({
      type: 'market',
      side: 'sell',
      price: null,
      protectionPrice: null,
      qty: parseAmount('1.5'),
      filledQty: parseAmount('1.5'),
      status: 'filled',
    });
    const wire = presentCcxtOrder(order, 'BTC/USDT');
    expect(orderSchema.safeParse(wire).success).toBe(true);
    expect(wire.price).toBeNull();
    expect(wire.cost).toBeNull();
    expect(wire.cost).not.toBe('0');
  });

  it('unfilled market sell still reports cost "0" (nothing moved)', () => {
    const order = fakeOrder({
      type: 'market',
      side: 'sell',
      price: null,
      protectionPrice: null,
      qty: parseAmount('1'),
      filledQty: parseAmount('0'),
      status: 'open',
    });
    const wire = presentCcxtOrder(order, 'BTC/USDT');
    expect(orderSchema.safeParse(wire).success).toBe(true);
    expect(wire.cost).toBe('0');
  });

  it('filled market sell with fills loaded: cost is Σ fill quoteAmount', () => {
    const order = fakeOrder({
      type: 'market',
      side: 'sell',
      price: null,
      protectionPrice: null,
      qty: parseAmount('2'),
      filledQty: parseAmount('2'),
      status: 'filled',
    });
    const fills = [
      fakeFill({ quoteAmount: parseAmount('100.5'), qty: parseAmount('1') }),
      fakeFill({ quoteAmount: parseAmount('99.5'), qty: parseAmount('1') }),
    ];
    const wire = presentCcxtOrder(order, 'BTC/USDT', { fills });
    expect(orderSchema.safeParse(wire).success).toBe(true);
    expect(wire.cost).toBe('200');
    expect(wire.cost).not.toBe('0');
  });

  it('presents a fill that validates against tradeSchema with decimal strings', () => {
    const fill = fakeFill({
      price: parseAmount('100.5'),
      qty: parseAmount('1.2'),
      quoteAmount: parseAmount('120.6'),
      feeAmount: parseAmount('0.12'),
      feeBps: 10,
    });
    const wire = presentCcxtMyTrade(fill, 'BTC/USDT');
    expect(tradeSchema.safeParse(wire).success).toBe(true);
    expect(wire.price).toBe('100.5');
    expect(wire.amount).toBe('1.2');
    expect(wire.fee?.rate).toBe('0.001');
    expect(typeof wire.cost).toBe('string');
  });

  it('presents TradingFee from market maker/taker bps (decimal rates, percentage true)', () => {
    const m = fakeMarket({ symbol: 'BTC/USDT', makerBps: 10, takerBps: 20 });
    const wire = presentCcxtTradingFee(m);
    expect(tradingFeeSchema.safeParse(wire).success).toBe(true);
    expect(wire.maker).toBe('0.001');
    expect(wire.taker).toBe('0.002');
    expect(wire.percentage).toBe(true);
    expect(typeof wire.maker).toBe('string');
  });

  it('presentCcxtBalances maps available→free and hold/escrow/stake/collateral→used', () => {
    const now = new Date('2023-11-14T22:13:20.000Z');
    const rows: Balance[] = [
      {
        account: { ownerType: 'user', ownerId: USER, assetId: 'USDT', kind: 'available' },
        accountId: 'a1',
        amount: parseAmount('1000'),
      },
      {
        account: { ownerType: 'user', ownerId: USER, assetId: 'USDT', kind: 'hold', purpose: 'order:o1' },
        accountId: 'a2',
        amount: parseAmount('100'),
      },
      {
        account: { ownerType: 'user', ownerId: USER, assetId: 'USDT', kind: 'hold', purpose: 'order:o2' },
        accountId: 'a3',
        amount: parseAmount('150'),
      },
      {
        account: { ownerType: 'user', ownerId: USER, assetId: 'IFC', kind: 'stake', purpose: 'token:stake:s1' },
        accountId: 'a4',
        amount: parseAmount('4000'),
      },
      {
        account: { ownerType: 'user', ownerId: USER, assetId: 'BTC', kind: 'escrow', purpose: 'trade:t1' },
        accountId: 'a5',
        amount: parseAmount('0.5'),
      },
      {
        account: { ownerType: 'user', ownerId: USER, assetId: 'ETH', kind: 'collateral' },
        accountId: 'a6',
        amount: parseAmount('2'),
      },
    ];
    const wire = presentCcxtBalances(rows, now);
    expect(balancesSchema.safeParse(wire).success).toBe(true);
    expect(wire.timestamp).toBe(now.getTime());
    expect(wire.datetime).toBe(now.toISOString());
    expect(wire.balances.USDT).toEqual({ free: '1000', used: '250', total: '1250' });
    expect(wire.balances.IFC).toEqual({ free: '0', used: '4000', total: '4000' });
    expect(wire.balances.BTC).toEqual({ free: '0', used: '0.5', total: '0.5' });
    expect(wire.balances.ETH).toEqual({ free: '0', used: '2', total: '2' });
    // Decimal strings only — never JS numbers on the wire.
    for (const entry of Object.values(wire.balances)) {
      expect(typeof entry.free).toBe('string');
      expect(typeof entry.used).toBe('string');
      expect(typeof entry.total).toBe('string');
    }
  });

  it('presentCcxtBalances returns honest empty balances for no ledger rows', () => {
    const wire = presentCcxtBalances([], new Date('2023-11-14T22:13:20.000Z'));
    expect(balancesSchema.safeParse(wire).success).toBe(true);
    expect(wire.balances).toEqual({});
  });
});

describe('mapCreateOrderBody', () => {
  it('maps CCXT create body to PlaceOrderInput with Amount qty/price', () => {
    const input = mapCreateOrderBody({
      symbol: 'BTC/USDT',
      type: 'limit',
      side: 'buy',
      amount: '1.5',
      price: '100',
      timeInForce: 'GTC',
      clientOrderId: 'bot-1',
    });
    expect(input.symbol).toBe('BTC/USDT');
    expect(input.side).toBe('buy');
    expect(input.type).toBe('limit');
    expect(input.qty).toBe(parseAmount('1.5'));
    expect(input.price).toBe(parseAmount('100'));
    expect(input.tif).toBe('GTC');
    expect(input.clientOrderId).toBe('bot-1');
  });

  it('maps postOnly to tif PO', () => {
    const input = mapCreateOrderBody({
      symbol: 'BTC/USDT',
      type: 'limit',
      side: 'sell',
      amount: '1',
      price: '100',
      postOnly: true,
      clientOrderId: 'bot-po',
    });
    expect(input.tif).toBe('PO');
  });

  it('rejects stop types at the REST boundary', () => {
    expect(() =>
      mapCreateOrderBody({
        symbol: 'BTC/USDT',
        type: 'stop',
        side: 'buy',
        amount: '1',
        stopPrice: '90',
        clientOrderId: 'bot-stop',
      }),
    ).toThrow(TradeError);
  });

  it('refuses maker-or-cancel with trade.invalid_tif', () => {
    expect(() =>
      mapCreateOrderBody({
        symbol: 'BTC/USDT',
        type: 'limit',
        side: 'buy',
        amount: '1',
        price: '100',
        timeInForce: 'MOC',
        clientOrderId: 'bot-moc',
      }),
    ).toThrow(expect.objectContaining({ name: 'TradeError', code: 'trade.invalid_tif' }));
  });
});

describe('private REST — mount boundary + order write path', () => {
  const market = fakeMarket({ id: 'm-btc', symbol: 'BTC/USDT' });
  const open = fakeOrder({
    id: ORDER_ID,
    marketId: market.id,
    qty: parseAmount('2'),
    filledQty: parseAmount('0'),
    price: parseAmount('100'),
  });
  const closed = fakeOrder({
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    marketId: market.id,
    status: 'filled',
    qty: parseAmount('1'),
    filledQty: parseAmount('1'),
    price: parseAmount('100'),
  });
  const fill = fakeFill({
    orderId: ORDER_ID,
    marketId: market.id,
    qty: parseAmount('1'),
    price: parseAmount('100'),
    quoteAmount: parseAmount('100'),
  });

  function deps(overrides: Partial<PrivateRestDeps> = {}): PrivateRestDeps {
    return {
      edgeSecret: SECRET,
      serviceName: 'svc-trade',
      openOrders: async () => [open],
      adminOpenOrders: async () => [open],
      orderHistory: async () => [closed],
      getOrder: async () => open,
      placeOrder: async () => open,
      cancelOrder: async () => ({ ...open, status: 'cancelled' }),
      cancelAllOrders: async () => [{ ...open, status: 'cancelled' }],
      massCancelOrders: async () => [{ ...open, status: 'cancelled' }],
      myFills: async () => [fill],
      marketBySymbol: async (symbol) => (symbol === 'BTC/USDT' ? market : null),
      marketById: async (id) => (id === market.id ? market : null),
      markets: async () => [market],
      userBalances: async () => [],
      listPositions: async () => [],
      listClosedPositions: async () => [],
      getPosition: async () => {
        throw new Error('getPosition not stubbed');
      },
      openPosition: async () => {
        throw new Error('openPosition not stubbed');
      },
      closePosition: async () => {
        throw new Error('closePosition not stubbed');
      },
      setLeverage: async () => {
        throw new Error('setLeverage not stubbed');
      },
      addIsolatedMargin: async () => {
        throw new Error('addIsolatedMargin not stubbed');
      },
      reduceIsolatedMargin: async () => {
        throw new Error('reduceIsolatedMargin not stubbed');
      },
      getOpenMarginCall: async () => null,
      getAdlDisclosure: async () => ({
        version: 'DIRECTION-2026-07-31:34',
        copy: 'stub',
        acknowledged: false,
        acknowledgedAt: null,
      }),
      ackAdlDisclosure: async () => ({
        version: 'DIRECTION-2026-07-31:34',
        copy: 'stub',
        acknowledged: true,
        acknowledgedAt: new Date(0).toISOString(),
      }),
      listAdlDisclosureEvents: async () => [],
      ...overrides,
    };
  }

  async function build(d: PrivateRestDeps = deps()) {
    const app = Fastify();
    registerPrivateRest(app, d);
    await app.ready();
    return app;
  }

  // ── GET /orders/open (existing) ───────────────────────────────────────────

  it('refuses an anonymous caller and does not read open orders', async () => {
    let read = false;
    const app = await build(
      deps({
        openOrders: async () => {
          read = true;
          return [];
        },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/orders/open' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('AuthenticationError');
    expect(read).toBe(false);
    await app.close();
  });

  /**
   * THE ONE THAT MATTERS.
   *
   * A client-forged principal header (full scopes, mfa) must not open the door.
   * createEdgeContext drops unsigned principals to null — same as tRPC mount.
   */
  it('refuses a self-asserted principal, however privileged it claims to be', async () => {
    let read = false;
    let placed = false;
    const app = await build(
      deps({
        openOrders: async () => {
          read = true;
          return [];
        },
        placeOrder: async () => {
          placed = true;
          return open;
        },
      }),
    );
    const forged = encodePrincipal(principal({ scopes: ['trade:read', 'trade:write', 'admin:treasury'], tier: 'full', mfa: true }));
    const headers = {
      'x-intafaced-principal': forged,
      'x-intafaced-region': 'DE',
    };
    const openRes = await app.inject({ method: 'GET', url: '/api/v1/orders/open', headers });
    expect(openRes.statusCode).toBe(401);
    expect(read).toBe(false);

    const placeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '1', price: '100', clientOrderId: 'auth-check' },
    });
    expect(placeRes.statusCode).toBe(401);
    expect(placed).toBe(false);
    await app.close();
  });

  it('accepts an edge-signed principal and returns CCXT-shaped open orders', async () => {
    let seenUser: string | null = null;
    const app = await build(
      deps({
        openOrders: async (p) => {
          seenUser = p.userId;
          return [open];
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/orders/open?limit=100',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(seenUser).toBe(USER);
    const body = res.json() as unknown[];
    expect(body).toHaveLength(1);
    expect(orderSchema.safeParse(body[0]).success).toBe(true);
    expect((body[0] as { symbol: string; status: string }).symbol).toBe('BTC/USDT');
    expect((body[0] as { status: string }).status).toBe('open');
    expect(typeof (body[0] as { amount: string }).amount).toBe('string');
    await app.close();
  });

  it('returns empty array when the principal has no open orders', async () => {
    const app = await build(deps({ openOrders: async () => [] }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/orders/open?limit=100',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it('admin open orders requires admin:read and exposes canonical rows as decimal strings', async () => {
    const app = await build();
    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orders/open',
      headers: signedHeaders(),
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orders/open?limit=100',
      headers: signedHeaders(principal({ scopes: ['admin:read'] })),
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject([
      {
        id: ORDER_ID,
        userId: USER,
        symbol: 'BTC/USDT',
        amount: '2',
        filled: '0',
        price: '100',
        status: 'open',
        seeded: false,
      },
    ]);
    await app.close();
  });

  const PUBLISHED = parseFeeScheduleJson(
    JSON.stringify({ published: true, version: 'desk', makerBps: '8', takerBps: '10', perpetual: { makerBps: '2', takerBps: '5' } }),
  );

  it('admin fees requires admin:read and returns the charged schedule, not the listing-row bps', async () => {
    const rich = fakeMarket({ id: market.id, symbol: 'BTC/USDT', makerBps: 10, takerBps: 20 });
    const app = await build(deps({ markets: async () => [rich], feeSchedule: PUBLISHED }));
    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/fees',
      headers: signedHeaders(),
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/fees',
      headers: signedHeaders(principal({ scopes: ['admin:read'] })),
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({
      source: 'TRADE_FEE_SCHEDULE',
      version: 'desk',
      markets: [
        {
          symbol: 'BTC/USDT',
          kind: 'spot',
          product: 'spot',
          charged: { makerBps: '8', takerBps: '10', makerRate: '0.0008', takerRate: '0.001' },
          refusal: null,
        },
      ],
    });
    await app.close();
  });

  it('admin fees refuses with trade.fee_schedule_blank when the schedule is unpublished', async () => {
    const rich = fakeMarket({ id: market.id, symbol: 'BTC/USDT', makerBps: 10, takerBps: 20 });
    const app = await build(deps({ markets: async () => [rich], feeSchedule: parseFeeScheduleJson('') }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/fees',
      headers: signedHeaders(principal({ scopes: ['admin:read'] })),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ intafacedCode: 'trade.fee_schedule_blank' });
    expect(JSON.stringify(res.json())).not.toMatch(/"10"|"20"/);
    await app.close();
  });

  it('presentAdminFees reads the perpetual block for futures and refuses options and a missing perpetual block', () => {
    const futures = fakeMarket({ symbol: 'BTC-PERP', kind: 'futures', makerBps: 10, takerBps: 20 });
    const options = fakeMarket({ symbol: 'BTC-OPT', kind: 'options', makerBps: 10, takerBps: 20 });
    const published = PUBLISHED as Extract<typeof PUBLISHED, { published: true }>;
    const rows = presentAdminFees([futures, options], published).markets;
    expect(rows[0]).toMatchObject({
      product: 'perpetual',
      charged: { makerBps: '2', takerBps: '5', makerRate: '0.0002', takerRate: '0.0005' },
    });
    expect(rows[1]).toMatchObject({ product: null, charged: null, refusal: 'trade.fee_product_unpublished' });
    const noPerp = parseFeeScheduleJson(JSON.stringify({ published: true, version: 'v', makerBps: '8', takerBps: '10' }));
    const none = presentAdminFees([futures], noPerp as Extract<typeof noPerp, { published: true }>).markets;
    expect(none[0]).toMatchObject({ charged: null, refusal: 'trade.fee_product_unpublished' });
  });

  it('filters open orders by symbol when provided', async () => {
    let seenMarket: string | undefined = 'unset';
    const app = await build(
      deps({
        openOrders: async (_p, marketId) => {
          seenMarket = marketId;
          return [];
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/orders/open?symbol=BTC%2FUSDT&limit=100',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(seenMarket).toBe(market.id);
    await app.close();
  });

  it('404s when symbol filter names an unknown market', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/orders/open?symbol=NOPE%2FUSDT',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('BadSymbol');
    await app.close();
  });

  it('maps AuthError from openOrders to 403 (scope miss)', async () => {
    const app = await build(
      deps({
        openOrders: async () => {
          throw new AuthError('Scope "trade:read" is required', 'scope.denied');
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/orders/open?limit=100',
      headers: signedHeaders(principal({ scopes: [] })),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('PermissionDenied');
    await app.close();
  });

  // ── POST /orders (create — money path) ────────────────────────────────────

  it('POST /orders: forged principal never reaches placeOrder', async () => {
    let placed = false;
    const app = await build(
      deps({
        placeOrder: async () => {
          placed = true;
          return open;
        },
      }),
    );
    const forged = encodePrincipal(principal({ scopes: ['trade:write'], tier: 'full', mfa: true }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: {
        'x-intafaced-principal': forged,
        'x-intafaced-region': 'DE',
        'content-type': 'application/json',
      },
      payload: { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '1', price: '100', clientOrderId: 'forged-check' },
    });
    expect(res.statusCode).toBe(401);
    expect(placed).toBe(false);
    await app.close();
  });

  it('POST /orders: signed principal places via placeOrder with Amounts (not numbers)', async () => {
    let seen: PlaceOrderInput | null = null;
    let seenUser: string | null = null;
    const app = await build(
      deps({
        placeOrder: async (p, input) => {
          seenUser = p.userId;
          seen = input;
          return open;
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: {
        symbol: 'BTC/USDT',
        type: 'limit',
        side: 'buy',
        amount: '1.5',
        price: '100.25',
        clientOrderId: 'bot-42',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(seenUser).toBe(USER);
    expect(seen).not.toBeNull();
    expect(seen!.qty).toBe(parseAmount('1.5'));
    expect(seen!.price).toBe(parseAmount('100.25'));
    expect(typeof seen!.qty).toBe('bigint');
    expect(typeof seen!.price).toBe('bigint');
    expect(seen!.clientOrderId).toBe('bot-42');
    const body = res.json() as { symbol: string; amount: string; status: string };
    expect(orderSchema.safeParse(body).success).toBe(true);
    expect(body.symbol).toBe('BTC/USDT');
    expect(typeof body.amount).toBe('string');
    await app.close();
  });

  it('POST /orders: 400 when limit has no price', async () => {
    let placed = false;
    const app = await build(
      deps({
        placeOrder: async () => {
          placed = true;
          return open;
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '1', clientOrderId: 'no-price' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('InvalidOrder');
    expect(placed).toBe(false);
    await app.close();
  });

  it('POST /orders: 400 when clientOrderId is missing — retry would double-hold', async () => {
    let placed = false;
    const app = await build(
      deps({
        placeOrder: async () => {
          placed = true;
          return open;
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '1', price: '100' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('InvalidOrder');
    expect(placed).toBe(false);
    await app.close();
  });

  it('POST /orders: maps TradeError from placeOrder (insufficient path uses domain codes)', async () => {
    const app = await build(
      deps({
        placeOrder: async () => {
          throw new TradeError('spot trading is disabled by the operator kill-switch', 'trade.spot_disabled');
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      // clientOrderId required at the door — without it this test only proves 400 InvalidOrder
      payload: {
        symbol: 'BTC/USDT',
        type: 'market',
        side: 'buy',
        amount: '1',
        clientOrderId: 'map-trade-error',
      },
    });
    // The operator kill-switch is a temporary, venue-wide condition, so CCXT
    // `OnMaintenance` + 503 — a retryable state. It used to answer 403, which a
    // bot reads as "your key may not do this" and gives up on permanently.
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('OnMaintenance');
    expect(res.json().intafacedCode).toBe('trade.spot_disabled');
    await app.close();
  });

  // ── POST /orders/batch (bounded sequential money path) ────────────────────

  function batchOrder(input: PlaceOrderInput, overrides: Parameters<typeof fakeOrder>[0] = {}) {
    return fakeOrder({
      marketId: market.id,
      clientOrderId: input.clientOrderId,
      side: input.side,
      type: input.type as 'market' | 'limit',
      qty: input.qty,
      price: input.price ?? null,
      ...overrides,
    });
  }

  it('POST /orders/batch: all-success preserves order and decimal-string wire output', async () => {
    const seen: PlaceOrderInput[] = [];
    const app = await build(
      deps({
        placeOrder: async (_p, input) => {
          seen.push(input);
          return batchOrder(input);
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/batch',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: {
        orders: [
          { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '1.5', price: '100.25', clientOrderId: 'batch-a' },
          { symbol: 'BTC/USDT', type: 'market', side: 'sell', amount: '0.25', clientOrderId: 'batch-b' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { results: Array<{ status: string; order?: { clientOrderId: string; amount: string } }> };
    expect(body.results.map((r) => r.status)).toEqual(['success', 'success']);
    expect(body.results.map((r) => r.order?.clientOrderId)).toEqual(['batch-a', 'batch-b']);
    expect(body.results[0]!.order?.amount).toBe('1.5');
    expect(seen.map((input) => input.clientOrderId)).toEqual(['batch-a', 'batch-b']);
    expect(typeof (seen[0] as unknown as { qty: unknown }).qty).toBe('bigint');
    await app.close();
  });

  it('POST /orders/batch: mixed success/refusal continues after an item refusal', async () => {
    const seen: string[] = [];
    const app = await build(
      deps({
        placeOrder: async (_p, input) => {
          seen.push(input.clientOrderId!);
          if (input.clientOrderId === 'reject-me') throw new TradeError('spot trading is disabled', 'trade.spot_disabled');
          return batchOrder(input);
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/batch',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: {
        orders: [
          { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '1', price: '100', clientOrderId: 'first' },
          { symbol: 'BTC/USDT', type: 'market', side: 'buy', amount: '1', clientOrderId: 'reject-me' },
          { symbol: 'BTC/USDT', type: 'market', side: 'sell', amount: '1', clientOrderId: 'third' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { results: Array<{ status: string; clientOrderId: string; error?: { intafacedCode?: string } }> };
    expect(body.results.map((r) => r.status)).toEqual(['success', 'refused', 'success']);
    expect(body.results[1]!.error?.intafacedCode).toBe('trade.spot_disabled');
    expect(seen).toEqual(['first', 'reject-me', 'third']);
    await app.close();
  });

  it('POST /orders/batch: unresolved service order is returned as unknown evidence', async () => {
    const app = await build(
      deps({
        placeOrder: async (_p, input) =>
          batchOrder(input, {
            status: 'recovery_required',
            recoveryReason: 'SUBMIT_UNKNOWN',
            reconciliationKey: 'trade.order.reconcile:batch-unknown',
          }),
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/batch',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: {
        orders: [{ symbol: 'BTC/USDT', type: 'market', side: 'buy', amount: '1', clientOrderId: 'unknown-item' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({
      status: 'unknown',
      evidence: { outcome: 'OUTCOME_UNKNOWN', state: 'SUBMIT_UNKNOWN' },
    });
    await app.close();
  });

  it('POST /orders/batch: same fingerprint replays and conflicting clientOrderId reuse refuses', async () => {
    let calls = 0;
    const original = batchOrder({
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      qty: parseAmount('1'),
      price: parseAmount('100'),
      clientOrderId: 'stable',
    });
    const app = await build(
      deps({
        placeOrder: async () => {
          calls += 1;
          return original;
        },
      }),
    );
    const request = {
      orders: [{ symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '1', price: '100', clientOrderId: 'stable' }],
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/batch',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: request,
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/batch',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: request,
    });
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/batch',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: { orders: [{ ...request.orders[0], amount: '2' }] },
    });
    expect(first.json().results[0].status).toBe('success');
    expect(replay.json().results[0].order.id).toBe(first.json().results[0].order.id);
    expect(conflict.json().results[0]).toMatchObject({ status: 'refused', error: { intafacedCode: 'trade.client_order_id_conflict' } });
    // The route makes one service call per transport attempt; TradeService's
    // existing retry fence prevents a second hold/engine submit underneath it.
    expect(calls).toBe(3);
    await app.close();
  });

  it('POST /orders/batch: malformed item is safely represented and valid neighbors remain ordered', async () => {
    const seen: string[] = [];
    const app = await build(
      deps({
        placeOrder: async (_p, input) => {
          seen.push(input.clientOrderId!);
          return batchOrder(input);
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/batch',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: {
        orders: [
          { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '1', price: '100' },
          { symbol: 'BTC/USDT', type: 'market', side: 'sell', amount: '0.5', clientOrderId: 'after-malformed' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      results: Array<{ index: number; status: string; clientOrderId: string | null; error?: { code: string } }>;
    };
    expect(body.results.map((r) => [r.index, r.status, r.clientOrderId])).toEqual([
      [0, 'refused', null],
      [1, 'success', 'after-malformed'],
    ]);
    expect(body.results[0]!.error?.code).toBe('InvalidOrder');
    expect(seen).toEqual(['after-malformed']);
    await app.close();
  });

  it('POST /orders/batch: auth and jurisdiction failures are request-wide before item processing', async () => {
    let placed = 0;
    const app = await build(
      deps({
        placeOrder: async () => {
          placed += 1;
          return open;
        },
      }),
    );
    const payload = {
      orders: [{ symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '1', price: '100', clientOrderId: 'never-place' }, { nope: true }],
    };
    const scope = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/batch',
      headers: { ...signedHeaders(principal({ scopes: [] })), 'content-type': 'application/json' },
      payload,
    });
    expect(scope.statusCode).toBe(403);
    expect(scope.json().code).toBe('PermissionDenied');
    expect(placed).toBe(0);

    const jurisdiction = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/batch',
      headers: { ...signedHeaders(undefined, 'US'), 'content-type': 'application/json' },
      payload,
    });
    expect(jurisdiction.statusCode).toBe(403);
    expect(jurisdiction.json().code).toBe('PermissionDenied');
    expect(placed).toBe(0);
    await app.close();
  });

  it('POST /orders/batch: empty and over-bound lists refuse before placeOrder', async () => {
    let placed = 0;
    const app = await build(
      deps({
        placeOrder: async () => {
          placed += 1;
          return open;
        },
      }),
    );
    const headers = { ...signedHeaders(), 'content-type': 'application/json' };
    const empty = await app.inject({ method: 'POST', url: '/api/v1/orders/batch', headers, payload: { orders: [] } });
    const tooMany = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/batch',
      headers,
      payload: { orders: Array.from({ length: 101 }, () => ({ nope: true })) },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().intafacedCode).toBe('trade.batch_empty');
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().intafacedCode).toBe('trade.batch_too_large');
    expect(placed).toBe(0);
    await app.close();
  });

  // ── DELETE /orders/:id ────────────────────────────────────────────────────

  it('DELETE /orders/:id: forged → 401, never cancelOrder', async () => {
    let cancelled = false;
    const app = await build(
      deps({
        cancelOrder: async () => {
          cancelled = true;
          return open;
        },
      }),
    );
    const forged = encodePrincipal(principal({ scopes: ['trade:write'] }));
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/orders/${ORDER_ID}`,
      headers: { 'x-intafaced-principal': forged, 'x-intafaced-region': 'DE' },
    });
    expect(res.statusCode).toBe(401);
    expect(cancelled).toBe(false);
    await app.close();
  });

  it('DELETE /orders/:id: signed cancel returns CCXT canceled order', async () => {
    let seenId: string | null = null;
    const app = await build(
      deps({
        cancelOrder: async (_p, id) => {
          seenId = id;
          return { ...open, status: 'cancelled' };
        },
      }),
    );
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/orders/${ORDER_ID}`,
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(seenId).toBe(ORDER_ID);
    const body = res.json() as { status: string };
    expect(orderSchema.safeParse(body).success).toBe(true);
    expect(body.status).toBe('canceled');
    await app.close();
  });

  it('POST /orders/:id/replace returns an explicit two-step saga outcome', async () => {
    let seen: { orderId: string; clientOrderId?: string; qty?: bigint } | null = null;
    const replacement = fakeOrder({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      clientOrderId: 'replace:amend-1',
      qty: parseAmount('1.5'),
      price: parseAmount('101'),
      status: 'open',
    });
    const app = await build(
      deps({
        replaceOrder: async (_p, orderId, input) => {
          seen = { orderId, clientOrderId: input.clientOrderId, qty: input.qty };
          return {
            accepted: true,
            idempotent: false,
            code: 'REPLACED',
            reasonCode: null,
            reconciliationRequired: false,
            original: { ...open, status: 'cancelled' },
            replacement,
          };
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/orders/${ORDER_ID}/replace`,
      headers: signedHeaders(),
      payload: {
        symbol: 'BTC/USDT',
        type: 'limit',
        side: 'buy',
        amount: '1.5',
        price: '101',
        clientOrderId: 'amend-1',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toMatchObject({ orderId: ORDER_ID, clientOrderId: 'amend-1' });
    expect((seen as unknown as { qty?: bigint }).qty).toBe(parseAmount('1.5'));
    expect(res.json()).toMatchObject({
      accepted: true,
      code: 'REPLACED',
      path: 'CANCEL_REPLACE',
      reconciliationRequired: false,
      originalOrderId: ORDER_ID,
      originalState: 'cancelled',
      replacementOrderId: replacement.id,
      replacementState: 'open',
    });
    await app.close();
  });

  it('PATCH /orders/:id is native amend, never cancel/replace', async () => {
    let seenOrderId: string | null = null;
    let seenQty: bigint | null = null;
    const app = await build(
      deps({
        amendOrder: async (_p, orderId, input) => {
          seenOrderId = orderId;
          seenQty = input.qty;
          return {
            accepted: true,
            idempotent: false,
            code: 'AMENDED',
            reasonCode: null,
            reconciliationRequired: false,
            path: 'NATIVE_AMEND',
            priority: 'retained',
            order: fakeOrder({ id: ORDER_ID, qty: parseAmount('1'), status: 'open' }),
          };
        },
      }),
    );
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/orders/${ORDER_ID}`,
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: { qty: '1' },
    });
    expect(res.statusCode).toBe(200);
    expect(seenOrderId).toBe(ORDER_ID);
    expect(seenQty).toBe(parseAmount('1'));
    expect(res.json()).toMatchObject({
      accepted: true,
      code: 'AMENDED',
      path: 'NATIVE_AMEND',
      priority: 'retained',
      orderId: ORDER_ID,
    });
    await app.close();
  });

  // ── POST /orders/batch-amend (bounded sequential native amend) ───────────

  it('POST /orders/batch-amend: mixed APPLIED/REFUSED continues and never silent-replaces', async () => {
    const seen: Array<{ orderId: string; qty: bigint; side?: string; price?: bigint | null }> = [];
    let replaced = 0;
    const app = await build(
      deps({
        replaceOrder: async () => {
          replaced += 1;
          throw new Error('batch-amend must not call replaceOrder');
        },
        amendOrder: async (_p, orderId, input) => {
          seen.push({ orderId, qty: input.qty, side: input.side, price: input.price });
          if (orderId === 'price-change' || orderId === 'side-change') {
            return {
              accepted: false,
              idempotent: false,
              code: 'CANCEL_REPLACE',
              reasonCode: orderId === 'price-change' ? 'trade.amend_price_change' : 'trade.amend_side_change',
              reconciliationRequired: false,
              path: 'NATIVE_AMEND',
              priority: null,
              order: fakeOrder({ id: orderId, qty: parseAmount('2'), status: 'open' }),
            };
          }
          return {
            accepted: true,
            idempotent: false,
            code: 'AMENDED',
            reasonCode: null,
            reconciliationRequired: false,
            path: 'NATIVE_AMEND',
            priority: 'retained',
            order: fakeOrder({ id: orderId, qty: input.qty, status: 'open' }),
          };
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/batch-amend',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: {
        amends: [
          { id: 'qty-down', qty: '1.25' },
          { id: 'price-change', qty: '1', price: '101.5' },
          { orderId: 'side-change', amount: '1', side: 'sell' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      atomic: boolean;
      results: Array<{ status: string; code?: string; path?: string; order?: { amount: string } }>;
    };
    expect(body.atomic).toBe(false);
    expect(body.results.map((r) => r.status)).toEqual(['APPLIED', 'REFUSED', 'REFUSED']);
    expect(body.results[0]).toMatchObject({ code: 'AMENDED', path: 'NATIVE_AMEND', order: { amount: '1.25' } });
    expect(body.results[1]).toMatchObject({ code: 'CANCEL_REPLACE', path: 'NATIVE_AMEND', reasonCode: 'trade.amend_price_change' });
    expect(body.results[2]).toMatchObject({ code: 'CANCEL_REPLACE', path: 'NATIVE_AMEND', reasonCode: 'trade.amend_side_change' });
    expect(seen.map((item) => item.orderId)).toEqual(['qty-down', 'price-change', 'side-change']);
    expect(seen[0]!.qty).toBe(parseAmount('1.25'));
    expect(seen[1]!.price).toBe(parseAmount('101.5'));
    expect(replaced).toBe(0);
    await app.close();
  });

  it('POST /orders/batch-amend: unresolved item is OUTCOME_UNKNOWN and later items still run', async () => {
    const seen: string[] = [];
    const app = await build(
      deps({
        amendOrder: async (_p, orderId, input) => {
          seen.push(orderId);
          if (orderId === 'unknown-item') {
            return {
              accepted: false,
              idempotent: false,
              code: 'AMEND_UNKNOWN',
              reasonCode: 'AMEND_UNKNOWN',
              reconciliationRequired: true,
              path: 'NATIVE_AMEND',
              priority: null,
              order: fakeOrder({
                id: orderId,
                qty: parseAmount('2'),
                status: 'recovery_required',
                recoveryReason: 'AMEND_UNKNOWN',
                reconciliationKey: 'trade.order.reconcile:batch-amend-unknown',
              }),
            };
          }
          return {
            accepted: true,
            idempotent: false,
            code: 'AMENDED',
            reasonCode: null,
            reconciliationRequired: false,
            path: 'NATIVE_AMEND',
            priority: 'retained',
            order: fakeOrder({ id: orderId, qty: input.qty, status: 'open' }),
          };
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/batch-amend',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: {
        orders: [
          { id: 'unknown-item', qty: '1' },
          { id: 'after-unknown', qty: '0.5' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().atomic).toBe(false);
    expect(res.json().results.map((r: { status: string }) => r.status)).toEqual(['OUTCOME_UNKNOWN', 'APPLIED']);
    expect(res.json().results[0]).toMatchObject({
      evidence: { outcome: 'OUTCOME_UNKNOWN', code: 'AMEND_UNKNOWN', reconciliationRequired: true },
      reconciliationRequired: true,
    });
    expect(seen).toEqual(['unknown-item', 'after-unknown']);
    await app.close();
  });

  it('POST /orders/batch-amend: auth and jurisdiction failures are request-wide before items', async () => {
    let amended = 0;
    const app = await build(
      deps({
        amendOrder: async () => {
          amended += 1;
          throw new Error('must not amend');
        },
      }),
    );
    const payload = { amends: [{ id: ORDER_ID, qty: '1' }, { nope: true }] };
    const scope = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/batch-amend',
      headers: { ...signedHeaders(principal({ scopes: [] })), 'content-type': 'application/json' },
      payload,
    });
    expect(scope.statusCode).toBe(403);
    expect(scope.json().code).toBe('PermissionDenied');
    expect(amended).toBe(0);

    const jurisdiction = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/batch-amend',
      headers: { ...signedHeaders(undefined, 'US'), 'content-type': 'application/json' },
      payload,
    });
    expect(jurisdiction.statusCode).toBe(403);
    expect(jurisdiction.json().code).toBe('PermissionDenied');
    expect(amended).toBe(0);
    await app.close();
  });

  it('POST /orders/batch-amend: empty and over-bound lists refuse before amendOrder', async () => {
    let amended = 0;
    const app = await build(
      deps({
        amendOrder: async () => {
          amended += 1;
          throw new Error('must not amend');
        },
      }),
    );
    const headers = { ...signedHeaders(), 'content-type': 'application/json' };
    const empty = await app.inject({ method: 'POST', url: '/api/v1/orders/batch-amend', headers, payload: { amends: [] } });
    const tooMany = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/batch-amend',
      headers,
      payload: { amends: Array.from({ length: 101 }, (_, i) => ({ id: `o-${i}`, qty: '1' })) },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().intafacedCode).toBe('trade.batch_empty');
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().intafacedCode).toBe('trade.batch_too_large');
    expect(amended).toBe(0);
    await app.close();
  });

  it('parseAmendOrderBody keeps qty as Amount and rejects JSON numbers', () => {
    const ok = parseAmendOrderBody({ qty: '1.25', price: '100.5' });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.input.qty).toBe(parseAmount('1.25'));
      expect(ok.input.price).toBe(parseAmount('100.5'));
    }
    expect(parseAmendOrderBody({ qty: 1 }).ok).toBe(false);
  });

  it('parseAmendOrderBody accepts expectedRemaining as money and expectedVersion as an integer', () => {
    const ok = parseAmendOrderBody({ qty: '1', expectedRemaining: '1.5', expectedVersion: 4 });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.input.expectedRemaining).toBe(parseAmount('1.5'));
      expect(ok.input.expectedVersion).toBe(4);
    }
    expect(parseAmendOrderBody({ qty: '1', expectedRemaining: 1.5 }).ok).toBe(false);
    expect(parseAmendOrderBody({ qty: '1', expectedVersion: '4' }).ok).toBe(false);
    expect(parseAmendOrderBody({ qty: '1', expectedVersion: -1 }).ok).toBe(false);
  });

  // ── GET /orders/:id ───────────────────────────────────────────────────────

  it('GET /orders/:id: forged → 401', async () => {
    let fetched = false;
    const app = await build(
      deps({
        getOrder: async () => {
          fetched = true;
          return open;
        },
      }),
    );
    const forged = encodePrincipal(principal());
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/orders/${ORDER_ID}`,
      headers: { 'x-intafaced-principal': forged, 'x-intafaced-region': 'DE' },
    });
    expect(res.statusCode).toBe(401);
    expect(fetched).toBe(false);
    await app.close();
  });

  it('GET /orders/:id: signed returns order; not found → 404', async () => {
    const appOk = await build();
    const ok = await appOk.inject({
      method: 'GET',
      url: `/api/v1/orders/${ORDER_ID}`,
      headers: signedHeaders(),
    });
    expect(ok.statusCode).toBe(200);
    expect(orderSchema.safeParse(ok.json()).success).toBe(true);
    await appOk.close();

    const appMiss = await build(
      deps({
        getOrder: async () => {
          throw new TradeError('order missing', 'trade.order_not_found');
        },
      }),
    );
    const miss = await appMiss.inject({
      method: 'GET',
      url: `/api/v1/orders/${ORDER_ID}`,
      headers: signedHeaders(),
    });
    expect(miss.statusCode).toBe(404);
    expect(miss.json().code).toBe('OrderNotFound');
    expect(miss.json().intafacedCode).toBe('trade.order_not_found');
    await appMiss.close();
  });

  // ── GET /orders/closed ────────────────────────────────────────────────────

  it('GET /orders/closed: forged → 401; signed returns closed list', async () => {
    let hist = false;
    const app = await build(
      deps({
        orderHistory: async () => {
          hist = true;
          return [closed];
        },
      }),
    );
    const forged = encodePrincipal(principal());
    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/orders/closed',
      headers: { 'x-intafaced-principal': forged, 'x-intafaced-region': 'DE' },
    });
    expect(denied.statusCode).toBe(401);
    expect(hist).toBe(false);

    const ok = await app.inject({
      method: 'GET',
      url: '/api/v1/orders/closed?limit=100',
      headers: signedHeaders(),
    });
    expect(ok.statusCode).toBe(200);
    expect(hist).toBe(true);
    const body = ok.json() as unknown[];
    expect(body).toHaveLength(1);
    expect(orderSchema.safeParse(body[0]).success).toBe(true);
    expect((body[0] as { status: string }).status).toBe('closed');
    await app.close();
  });

  // ── GET /account/trades ───────────────────────────────────────────────────

  it('GET /account/trades: forged → 401; signed returns my fills as tradeSchema', async () => {
    let listed = false;
    const app = await build(
      deps({
        myFills: async () => {
          listed = true;
          return [fill];
        },
      }),
    );
    const forged = encodePrincipal(principal());
    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/account/trades',
      headers: { 'x-intafaced-principal': forged, 'x-intafaced-region': 'DE' },
    });
    expect(denied.statusCode).toBe(401);
    expect(listed).toBe(false);

    const ok = await app.inject({
      method: 'GET',
      url: '/api/v1/account/trades?limit=100',
      headers: signedHeaders(),
    });
    expect(ok.statusCode).toBe(200);
    expect(listed).toBe(true);
    const body = ok.json() as unknown[];
    expect(body).toHaveLength(1);
    expect(tradeSchema.safeParse(body[0]).success).toBe(true);
    expect(typeof (body[0] as { price: string }).price).toBe('string');
    await app.close();
  });

  it('GET /account/trades?symbol=: passes marketId into myFills (SQL filter)', async () => {
    let seenMarket: string | undefined = 'unset';
    let seenLimit: number | undefined;
    const app = await build(
      deps({
        myFills: async (_p, limit, marketId) => {
          seenLimit = limit;
          seenMarket = marketId;
          return [fill];
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/account/trades?symbol=BTC%2FUSDT&limit=100',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(seenMarket).toBe(market.id);
    expect(seenLimit).toBe(100);
    const body = res.json() as unknown[];
    expect(body).toHaveLength(1);
    expect(tradeSchema.safeParse(body[0]).success).toBe(true);
    expect((body[0] as { symbol: string }).symbol).toBe('BTC/USDT');
    await app.close();
  });

  it('GET /account/trades?symbol=: known market with no fills → 200 []', async () => {
    let seenMarket: string | undefined = 'unset';
    const app = await build(
      deps({
        myFills: async (_p, _limit, marketId) => {
          seenMarket = marketId;
          return [];
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/account/trades?symbol=BTC%2FUSDT&limit=100',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(seenMarket).toBe(market.id);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it('GET /account/trades?symbol=: unknown market → 404 without myFills', async () => {
    let listed = false;
    const app = await build(
      deps({
        myFills: async () => {
          listed = true;
          return [fill];
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/account/trades?symbol=NOPE%2FUSDT&limit=100',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('BadSymbol');
    expect(listed).toBe(false);
    await app.close();
  });

  it('GET /account/trades without symbol: myFills gets no marketId (unfiltered)', async () => {
    let seenMarket: string | undefined = 'sentinel';
    const app = await build(
      deps({
        myFills: async (_p, _limit, marketId) => {
          seenMarket = marketId;
          return [fill];
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/account/trades?limit=100',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(seenMarket).toBeUndefined();
    expect(res.json()).toHaveLength(1);
    await app.close();
  });

  it('GET /account/trades?since=: passes sinceMs into myFills (SQL filter)', async () => {
    let seenSince: number | undefined = -1;
    let seenMarket: string | undefined = 'sentinel';
    const app = await build(
      deps({
        myFills: async (_p, _limit, marketId, sinceMs) => {
          seenMarket = marketId;
          seenSince = sinceMs;
          return [fill];
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/account/trades?since=1700000000000&symbol=BTC%2FUSDT&limit=100',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(seenSince).toBe(1_700_000_000_000);
    expect(seenMarket).toBe(market.id);
    expect(res.json()).toHaveLength(1);
    await app.close();
  });

  it('GET /account/trades?since=: invalid (NaN / negative) → 400 without myFills', async () => {
    let listed = false;
    const app = await build(
      deps({
        myFills: async () => {
          listed = true;
          return [fill];
        },
      }),
    );
    for (const since of ['not-a-number', '-1', 'NaN']) {
      listed = false;
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/account/trades?since=${encodeURIComponent(since)}&limit=100`,
        headers: signedHeaders(),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('BadRequest');
      expect(listed).toBe(false);
    }
    await app.close();
  });

  it('GET /orders/closed?since=: passes sinceMs into orderHistory', async () => {
    let seen: { marketId?: string; limit?: number; sinceMs?: number } | null = null;
    const app = await build(
      deps({
        orderHistory: async (_p, input) => {
          seen = input;
          return [closed];
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/orders/closed?since=1700000000000&symbol=BTC%2FUSDT&limit=100',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual({ marketId: market.id, limit: 100, sinceMs: 1_700_000_000_000 });
    expect(res.json()).toHaveLength(1);
    await app.close();
  });

  it('GET /orders/closed?since=: invalid (NaN / negative) → 400 without orderHistory', async () => {
    let listed = false;
    const app = await build(
      deps({
        orderHistory: async () => {
          listed = true;
          return [closed];
        },
      }),
    );
    for (const since of ['abc', '-5']) {
      listed = false;
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/orders/closed?since=${encodeURIComponent(since)}&limit=100`,
        headers: signedHeaders(),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('BadRequest');
      expect(listed).toBe(false);
    }
    await app.close();
  });

  // ── DELETE /orders (cancel all — money path) ──────────────────────────────

  it('DELETE /orders: forged principal never reaches cancelAllOrders', async () => {
    let cancelled = false;
    const app = await build(
      deps({
        cancelAllOrders: async () => {
          cancelled = true;
          return [];
        },
      }),
    );
    const forged = encodePrincipal(principal({ scopes: ['trade:write'], tier: 'full', mfa: true }));
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/orders',
      headers: { 'x-intafaced-principal': forged, 'x-intafaced-region': 'DE' },
    });
    expect(res.statusCode).toBe(401);
    expect(cancelled).toBe(false);
    await app.close();
  });

  it('DELETE /orders: signed cancel-all returns CCXT canceled order list', async () => {
    let seenUser: string | null = null;
    let seenMarket: string | undefined = 'unset';
    const app = await build(
      deps({
        cancelAllOrders: async (p, marketId) => {
          seenUser = p.userId;
          seenMarket = marketId;
          return [{ ...open, status: 'cancelled' }];
        },
      }),
    );
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/orders',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(seenUser).toBe(USER);
    expect(seenMarket).toBeUndefined();
    const body = res.json() as unknown[];
    expect(body).toHaveLength(1);
    expect(orderSchema.safeParse(body[0]).success).toBe(true);
    expect((body[0] as { status: string }).status).toBe('canceled');
    await app.close();
  });

  it('DELETE /orders?symbol=: filters market; unknown symbol → 404 without cancelAll', async () => {
    let seenMarket: string | undefined = 'unset';
    let cancelled = false;
    const app = await build(
      deps({
        cancelAllOrders: async (_p, marketId) => {
          cancelled = true;
          seenMarket = marketId;
          return [];
        },
      }),
    );
    const ok = await app.inject({
      method: 'DELETE',
      url: '/api/v1/orders?symbol=BTC%2FUSDT',
      headers: signedHeaders(),
    });
    expect(ok.statusCode).toBe(200);
    expect(cancelled).toBe(true);
    expect(seenMarket).toBe(market.id);

    cancelled = false;
    const miss = await app.inject({
      method: 'DELETE',
      url: '/api/v1/orders?symbol=NOPE%2FUSDT',
      headers: signedHeaders(),
    });
    expect(miss.statusCode).toBe(404);
    expect(miss.json().code).toBe('BadSymbol');
    expect(cancelled).toBe(false);
    await app.close();
  });

  it('DELETE /orders: empty open book returns [] (honest empty)', async () => {
    const app = await build(deps({ cancelAllOrders: async () => [] }));
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/orders',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  // ── POST /markets/:marketId/orders/mass-cancel ────────────────────────────

  it('POST mass-cancel: missing account (unauth) refuses and never reaches matching', async () => {
    let called = false;
    const app = await build(
      deps({
        massCancelOrders: async () => {
          called = true;
          return [];
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/markets/${market.id}/orders/mass-cancel`,
      headers: { 'content-type': 'application/json' },
      payload: { accountId: USER },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('AuthenticationError');
    expect(called).toBe(false);
    await app.close();
  });

  it('POST mass-cancel: cross-account refuses and never reaches matching', async () => {
    const foreign = '33333333-3333-4333-8333-333333333333';
    let seenUser: string | null = null;
    const app = await build(
      deps({
        massCancelOrders: async (p) => {
          seenUser = p.userId;
          return [];
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/markets/${market.id}/orders/mass-cancel`,
      headers: { 'content-type': 'application/json', ...signedHeaders() },
      payload: { accountId: foreign },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('PermissionDenied');
    expect(res.json().intafacedCode).toBe('trade.not_owner');
    expect(seenUser).toBeNull();
    await app.close();
  });

  it('POST mass-cancel: session id refuses — trade does not invent a session', async () => {
    let called = false;
    const app = await build(
      deps({
        massCancelOrders: async () => {
          called = true;
          return [];
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/markets/${market.id}/orders/mass-cancel`,
      headers: { 'content-type': 'application/json', ...signedHeaders() },
      payload: { accountId: USER, sessionId: 'sess-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toBe(false);
    expect(res.json().rejected.code).toBe('session_unsupported');
    expect(res.json().cancellations).toEqual([]);
    expect(called).toBe(false);
    await app.close();
  });

  it('POST mass-cancel: authenticated account pulls own rests through trade', async () => {
    let seenUser: string | null = null;
    let seenMarket: string | null = null;
    const app = await build(
      deps({
        massCancelOrders: async (p, marketId) => {
          seenUser = p.userId;
          seenMarket = marketId;
          return [{ ...open, status: 'cancelled' }];
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/markets/${market.id}/orders/mass-cancel`,
      headers: { 'content-type': 'application/json', ...signedHeaders() },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(seenUser).toBe(USER);
    expect(seenMarket).toBe(market.id);
    expect(res.json().accepted).toBe(true);
    expect(res.json().accountId).toBe(USER);
    expect(res.json().rejected).toBeNull();
    expect(res.json().cancellations).toHaveLength(1);
    expect(res.json().cancellations[0].status).toBe('canceled');
    await app.close();
  });

  // ── GET /account/fees ─────────────────────────────────────────────────────

  it('GET /account/fees: forged → 401; never lists markets', async () => {
    let listed = false;
    const app = await build(
      deps({
        markets: async () => {
          listed = true;
          return [market];
        },
      }),
    );
    const forged = encodePrincipal(principal({ scopes: ['trade:read'] }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/account/fees',
      headers: { 'x-intafaced-principal': forged, 'x-intafaced-region': 'DE' },
    });
    expect(res.statusCode).toBe(401);
    expect(listed).toBe(false);
    await app.close();
  });

  it('GET /account/fees: signed returns the owner schedule, not listing-row bps', async () => {
    const rich = fakeMarket({ id: market.id, symbol: 'BTC/USDT', makerBps: 10, takerBps: 20 });
    const app = await build(
      deps({
        markets: async () => [rich],
        feeSchedule: parseFeeScheduleJson(JSON.stringify({ published: true, version: 'desk', makerBps: '8', takerBps: '10' })),
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/account/fees',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, { maker: string; taker: string; makerBps: number; takerBps: number; version: string }>;
    expect(tradingFeeSchema.safeParse(body['BTC/USDT']).success).toBe(true);
    expect(body['BTC/USDT']?.maker).toBe('0.0008');
    expect(body['BTC/USDT']?.taker).toBe('0.001');
    expect(body['BTC/USDT']?.makerBps).toBe(8);
    expect(body['BTC/USDT']?.takerBps).toBe(10);
    expect(body['BTC/USDT']?.version).toBe('desk');
    await app.close();
  });

  it('private reads carry serverTime and rejected orders carry rejectCode', async () => {
    const clock = new Date('2026-10-17T04:05:00.000Z');
    const rejected = fakeOrder({ status: 'rejected', rejectCode: 'post_only_would_cross' });
    const app = await build(
      deps({
        now: () => clock,
        openOrders: async () => [rejected],
        myFills: async () => [fill],
        userBalances: async () => [],
      }),
    );
    const headers = signedHeaders();
    const orders = await app.inject({ method: 'GET', url: '/api/v1/orders/open?limit=10', headers });
    expect(orders.statusCode, orders.body).toBe(200);
    expect(orders.headers['x-server-time']).toBe(String(clock.getTime()));
    const orderWire = orders.json()[0];
    expect(orderWire.serverTime).toBe(clock.getTime());
    expect(orderWire.rejectCode).toBe('post_only_would_cross');
    expect(orderSchema.safeParse(orderWire).success).toBe(true);
    const bare = orderSchema.safeParse({ ...orderWire, rejectCode: undefined, serverTime: undefined });
    expect(bare.success).toBe(true);

    const fills = await app.inject({ method: 'GET', url: '/api/v1/account/trades?limit=10', headers });
    expect(fills.headers['x-server-time']).toBe(String(clock.getTime()));
    expect(fills.json()[0].serverTime).toBe(clock.getTime());
    expect(tradeSchema.safeParse(fills.json()[0]).success).toBe(true);

    const balances = await app.inject({ method: 'GET', url: '/api/v1/account/balance', headers });
    expect(balances.headers['x-server-time']).toBe(String(clock.getTime()));
    expect(balances.json().serverTime).toBe(clock.getTime());
    expect(balancesSchema.safeParse(balances.json()).success).toBe(true);
    await app.close();
  });

  it('GET /account/fees: empty markets → honest empty object', async () => {
    const app = await build(deps({ markets: async () => [] }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/account/fees',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    await app.close();
  });

  // ── GET /fees/published ───────────────────────────────────────────────────

  it('GET /fees/published: no principal needed; the owner schedule with its version, not listing-row bps', async () => {
    const rich = fakeMarket({ id: market.id, symbol: 'BTC/USDT', makerBps: 10, takerBps: 20 });
    const app = await build(
      deps({
        markets: async () => [rich],
        feeSchedule: parseFeeScheduleJson(JSON.stringify({ published: true, version: 'desk', makerBps: '8', takerBps: '10' })),
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/fees/published' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ version: 'desk', fees: { 'BTC/USDT': { makerBps: 8, takerBps: 10 } } });
    await app.close();
  });

  it('GET /fees/published: an unpublished schedule refuses by name and never lists markets', async () => {
    let listed = false;
    const app = await build(
      deps({
        markets: async () => {
          listed = true;
          return [market];
        },
        feeSchedule: parseFeeScheduleJson(''),
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/fees/published' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ intafacedCode: 'trade.fee_schedule_blank' });
    expect(listed).toBe(false);
    await app.close();
  });

  it('GET /fees/published: an empty listing answers the version with no rates', async () => {
    const app = await build(
      deps({
        markets: async () => [],
        feeSchedule: parseFeeScheduleJson(JSON.stringify({ published: true, version: 'desk', makerBps: '8', takerBps: '10' })),
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/fees/published' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: 'desk', fees: {} });
    await app.close();
  });

  // ── GET /account/balance ──────────────────────────────────────────────────

  it('GET /account/balance: forged → 401; never reads ledger', async () => {
    let read = false;
    const app = await build(
      deps({
        userBalances: async () => {
          read = true;
          return [];
        },
      }),
    );
    const forged = encodePrincipal(principal({ scopes: ['trade:read'] }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/account/balance',
      headers: { 'x-intafaced-principal': forged, 'x-intafaced-region': 'DE' },
    });
    expect(res.statusCode).toBe(401);
    expect(read).toBe(false);
    await app.close();
  });

  it('GET /account/balance: scope miss → 403; never reads ledger', async () => {
    let read = false;
    const app = await build(
      deps({
        userBalances: async () => {
          read = true;
          return [];
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/account/balance',
      headers: signedHeaders(principal({ scopes: [] })),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('PermissionDenied');
    expect(read).toBe(false);
    await app.close();
  });

  it('GET /account/balance: signed → self-only userId and balancesSchema wire', async () => {
    let seenUserId: string | undefined;
    const rows: Balance[] = [
      {
        account: { ownerType: 'user', ownerId: USER, assetId: 'USDT', kind: 'available' },
        accountId: 'a1',
        amount: parseAmount('1000'),
      },
      {
        account: { ownerType: 'user', ownerId: USER, assetId: 'USDT', kind: 'hold', purpose: 'order:o1' },
        accountId: 'a2',
        amount: parseAmount('250'),
      },
    ];
    const app = await build(
      deps({
        userBalances: async (userId) => {
          seenUserId = userId;
          return rows;
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/account/balance',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(seenUserId).toBe(USER);
    const body = res.json() as ReturnType<typeof presentCcxtBalances>;
    expect(balancesSchema.safeParse(body).success).toBe(true);
    expect(body.balances.USDT).toEqual({ free: '1000', used: '250', total: '1250' });
    expect(typeof body.balances.USDT!.free).toBe('string');
    await app.close();
  });

  it('GET /account/balance: empty wallet → honest empty balances object', async () => {
    const app = await build(deps({ userBalances: async () => [] }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/account/balance',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { balances: Record<string, unknown> };
    expect(balancesSchema.safeParse(body).success).toBe(true);
    expect(body.balances).toEqual({});
    await app.close();
  });

  // ── GET /positions (open rows; [] when none — F3) ───────────────────────────

  it('GET /positions: anonymous → 401', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/positions' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('AuthenticationError');
    await app.close();
  });

  it('GET /positions: self-asserted principal → 401 (fail closed)', async () => {
    const app = await build();
    const forged = encodePrincipal(principal({ scopes: ['trade:read', 'trade:write'], tier: 'full', mfa: true }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/positions',
      headers: { 'x-intafaced-principal': forged, 'x-intafaced-region': 'DE' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('AuthenticationError');
    await app.close();
  });

  it('GET /positions: scope miss → 403', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/positions',
      headers: signedHeaders(principal({ scopes: [] })),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('PermissionDenied');
    await app.close();
  });

  it('GET /positions: signed principal → 200 + [] when none open', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/positions',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it('GET /positions: returns stubbed open rows', async () => {
    const sample = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      symbol: 'BTC/USDT',
      timestamp: 1,
      datetime: '1970-01-01T00:00:00.001Z',
      side: 'long' as const,
      contracts: '1',
      contractSize: null,
      entryPrice: '50000',
      markPrice: null,
      notional: '50000',
      leverage: '10',
      collateral: '5000',
      initialMargin: '5000',
      maintenanceMargin: null,
      unrealizedPnl: null,
      realizedPnl: null,
      liquidationPrice: null,
      marginMode: 'isolated' as const,
      percentage: null,
    };
    const app = await build(deps({ listPositions: async () => [sample] }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/positions',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ ...sample, markSource: null }]);
    await app.close();
  });

  it('GET /positions/closed: anonymous → 401', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/positions/closed' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('AuthenticationError');
    await app.close();
  });

  it('GET /positions/closed: signed → 200 + [] when none settled', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/positions/closed?limit=100',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it('GET /positions/closed is not swallowed as GET /positions/:id', async () => {
    const closed = {
      id: ORDER_ID,
      symbol: 'BTC/USDT',
      timestamp: 1,
      datetime: '1970-01-01T00:00:00.001Z',
      side: 'long' as const,
      contracts: '1',
      contractSize: null,
      entryPrice: '50000',
      markPrice: null,
      notional: '50000',
      leverage: '10',
      collateral: '0',
      initialMargin: '5000',
      maintenanceMargin: null,
      unrealizedPnl: null,
      realizedPnl: null,
      liquidationPrice: null,
      marginMode: 'isolated' as const,
      percentage: null,
      status: 'closed' as const,
    };
    let getHits = 0;
    const app = await build(
      deps({
        listClosedPositions: async () => [closed],
        getPosition: async () => {
          getHits += 1;
          throw new FuturesError('position not found', 'trade.position_not_found', 404);
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/positions/closed?limit=100',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([closed]);
    expect(getHits).toBe(0);
    await app.close();
  });

  it('GET /positions/closed?since=: passes sinceMs and limit into listClosedPositions', async () => {
    let seen: { symbol?: string; limit?: number; sinceMs?: number } | null = null;
    const app = await build(
      deps({
        listClosedPositions: async (_p, input) => {
          seen = input;
          return [];
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/positions/closed?since=1700000000000&limit=2&symbol=BTC%2FUSDT',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual({ symbol: 'BTC/USDT', limit: 2, sinceMs: 1_700_000_000_000 });
    await app.close();
  });

  it('GET /positions/closed?since=: invalid → 400 without listClosedPositions', async () => {
    let listed = false;
    const app = await build(
      deps({
        listClosedPositions: async () => {
          listed = true;
          return [];
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/positions/closed?since=-1&limit=100',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(400);
    expect(listed).toBe(false);
    await app.close();
  });

  it('GET /positions/:id: anonymous → 401', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: `/api/v1/positions/${ORDER_ID}` });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('AuthenticationError');
    await app.close();
  });

  it('GET /positions/:id: signed → 200 for an owned row', async () => {
    const sample = {
      id: ORDER_ID,
      symbol: 'BTC/USDT',
      timestamp: 1,
      datetime: '1970-01-01T00:00:00.001Z',
      side: 'long' as const,
      contracts: '1',
      contractSize: null,
      entryPrice: '50000',
      markPrice: null,
      notional: '50000',
      leverage: '10',
      collateral: '5000',
      initialMargin: '5000',
      maintenanceMargin: null,
      unrealizedPnl: null,
      realizedPnl: null,
      liquidationPrice: null,
      marginMode: 'isolated' as const,
      percentage: null,
      status: 'open' as const,
    };
    const app = await build(deps({ getPosition: async () => sample }));
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/positions/${ORDER_ID}`,
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(sample);
    await app.close();
  });

  it('GET /positions/:id: missing / not theirs → 404 (same answer)', async () => {
    const app = await build(
      deps({
        getPosition: async () => {
          throw new FuturesError('position not found', 'trade.position_not_found', 404);
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/positions/${ORDER_ID}`,
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('trade.position_not_found');
    await app.close();
  });

  it('GET /positions/:id/margin-call still 404s when none is open', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/positions/${ORDER_ID}/margin-call`,
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('trade.margin_call_not_found');
    await app.close();
  });

  // ── A caller may not name a price (D-S-01) ──────────────────────────────────

  /**
   * `docs/adr/2026-08-05-futures-risk-and-mark-law.md`, refuse table row 1.
   *
   * Every test here asserts THE SERVICE WAS NEVER CALLED, not merely that the
   * status was 400 — the refusal has to happen before the money path, or it is
   * just a differently worded receipt for the same trade.
   */
  describe('caller-supplied prices are refused, not ignored', () => {
    for (const field of ['entryPrice', 'price', 'markPrice'] as const) {
      it(`POST /positions with ${field} → 400 trade.price_not_accepted, and openPosition is never called`, async () => {
        let called = false;
        const app = await build(
          deps({
            openPosition: async () => {
              called = true;
              throw new Error('should not reach the money path');
            },
          }),
        );
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/positions',
          headers: signedHeaders(),
          payload: { clientOpenId: 'rest-test-open', symbol: 'BTC/USDT-PERP', side: 'long', size: '1', leverage: '10', [field]: '1' },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe('trade.price_not_accepted');
        expect(res.json().message).toContain(field);
        expect(called).toBe(false);
        await app.close();
      });
    }

    it('names the price field before complaining about anything else the caller got wrong', async () => {
      const app = await build();
      // No symbol, no side, no size — and a price. The price is the answer.
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/positions',
        headers: signedHeaders(),
        payload: { clientOpenId: 'rest-test-open', entryPrice: '50000' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('trade.price_not_accepted');
      await app.close();
    });

    it('DELETE /positions/:id?exitPrice= → 400, and closePosition is never called', async () => {
      let called = false;
      const app = await build(
        deps({
          closePosition: async () => {
            called = true;
            throw new Error('should not reach the money path');
          },
        }),
      );
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/positions/${ORDER_ID}?exitPrice=999999`,
        headers: signedHeaders(),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('trade.price_not_accepted');
      expect(res.json().message).toContain('exitPrice');
      expect(called).toBe(false);
      await app.close();
    });

    it('DELETE /positions/:id?markPrice= → 400, and closePosition is never called', async () => {
      let called = false;
      const app = await build(
        deps({
          closePosition: async () => {
            called = true;
            throw new Error('should not reach the money path');
          },
        }),
      );
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/positions/${ORDER_ID}?markPrice=999999`,
        headers: signedHeaders(),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('trade.price_not_accepted');
      expect(res.json().message).toContain('markPrice');
      expect(called).toBe(false);
      await app.close();
    });

    /**
     * D26-P1-T1a public door: last-trade must not open through POST /positions.
     * Same entry gate PositionService.markFor runs (`acceptableForEntry`) — the
     * REST edge must surface the refuse before any money path flag is set.
     */
    it('POST /positions refuses when the mark port only has last-trade (DIRECTION MVP-1)', async () => {
      let moneyPath = false;
      const marks = markSourceFromBook({
        async readBook() {
          return { bestBid: null, bestAsk: null, last: '50000', observedAt: new Date() };
        },
      });
      const app = await build(
        deps({
          openPosition: async (_p, input) => {
            const at = new Date();
            const quoted = await marks.quote!({ marketId: 'door-m1', symbol: input.symbol, at });
            if (!quoted) {
              throw new FuturesError('no mark', 'trade.mark_missing', 503);
            }
            const check = acceptableForEntry(quoted, at, DEFAULT_FUTURES_MARK_POLICY);
            if (!check.ok) {
              throw new FuturesError(`Refusing to value this position — ${check.reason}`, check.code ?? 'trade.mark_unusable', 503);
            }
            moneyPath = true;
            return { id: 'should-not-open', symbol: input.symbol } as never;
          },
        }),
      );
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/positions',
        headers: signedHeaders(),
        payload: {
          clientOpenId: 'door-last-trade',
          symbol: 'BTC/USDT-PERP',
          side: 'long',
          size: '1',
          leverage: '10',
        },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('trade.mark_unusable');
      expect(res.json().committed).toBe(false);
      expect(res.json().message).toContain('last-trade');
      expect(moneyPath).toBe(false);
      await app.close();
    });

    it('a plain open does not answer position_mode_unset when the account mode is unset', async () => {
      let forwarded: string | undefined = 'missing';
      const app = await build(
        deps({
          readAccountMode: async () => ({ mode: null, source: 'unset', code: 'trade.position_mode_unset' }),
          openPosition: async (_principal, input) => {
            forwarded = input.positionMode;
            return { id: 'opened', symbol: input.symbol } as never;
          },
        }),
      );
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/positions',
        headers: signedHeaders(),
        payload: { clientOpenId: 'plain-open', symbol: 'BTC/USDT-PERP', side: 'long', size: '1', leverage: '10' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().error).toBeUndefined();
      expect(forwarded).toBeUndefined();
      await app.close();
    });

    it('an open on a one-way account forwards one_way when the body omits positionMode', async () => {
      let forwarded: string | undefined;
      const app = await build(
        deps({
          readAccountMode: async () => ({ mode: 'one_way', source: 'stored' }),
          openPosition: async (_principal, input) => {
            forwarded = input.positionMode;
            return { id: 'opened', symbol: input.symbol } as never;
          },
        }),
      );
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/positions',
        headers: signedHeaders(),
        payload: { clientOpenId: 'one-way-open', symbol: 'BTC/USDT-PERP', side: 'long', size: '1', leverage: '10' },
      });
      expect(res.statusCode).toBe(200);
      expect(forwarded).toBe('one_way');
      await app.close();
    });

    it('a genuine internal failure on open stays 5xx without committed', async () => {
      const app = await build(
        deps({
          openPosition: async () => {
            throw new FuturesError('boom', 'trade.internal', 500);
          },
        }),
      );
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/positions',
        headers: signedHeaders(),
        payload: { clientOpenId: 'internal', symbol: 'BTC/USDT-PERP', side: 'long', size: '1', leverage: '10' },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('trade.internal');
      expect(res.json().committed).toBeUndefined();
      await app.close();
    });

    it('a profitable close on an unusable mark answers 409 committed false', async () => {
      const app = await build(
        deps({
          closePositionQuantity: async () => {
            throw new FuturesError('Refusing to pay realised profit on this mark — last-trade', 'trade.mark_unusable', 503);
          },
        }),
      );
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/positions/${ORDER_ID}/close`,
        headers: signedHeaders(),
        payload: { quantity: '1', clientCloseId: 'close-mark-unusable' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'trade.mark_unusable', committed: false });
      await app.close();
    });

    /**
     * The refusal must not be silently-substitute. A caller who is told "no"
     * can fix their bot; a caller who is told "200 OK" while the platform used
     * a different number keeps sending the price and never finds out.
     */
    it('does not quietly re-price — the refusal explains what to send instead', async () => {
      const app = await build();
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/positions/${ORDER_ID}?exitPrice=999999`,
        headers: signedHeaders(),
      });
      expect(res.json().message).toContain('read from the mark source');
      expect(res.json().message).toContain('Resend without it');
      await app.close();
    });

    it('DELETE with no price is cancel-not-close and does not call closePosition', async () => {
      const seen: string[] = [];
      const app = await build(
        deps({
          closePosition: async (_p, id) => {
            seen.push(id);
            return { id, symbol: 'BTC/USDT-PERP' } as never;
          },
        }),
      );
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/positions/${ORDER_ID}`,
        headers: signedHeaders(),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('trade.cancel_not_close');
      expect(seen).toEqual([]);
      await app.close();
    });

    it('POST /positions/:id/close unnamed pot on winning close is NotSupported, not a 5xx retry', async () => {
      const app = await build(
        deps({
          closePositionQuantity: async () => {
            throw new FuturesError('cannot pay', 'trade.profit_source_unconfigured', 403);
          },
        }),
      );
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/positions/${ORDER_ID}/close`,
        headers: signedHeaders(),
        payload: { quantity: '1', clientCloseId: 'close-1' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        error: 'trade.profit_source_unconfigured',
        ccxtCode: 'NotSupported',
        retry: false,
      });
      await app.close();
    });

    it('POST with no price opens at the mark, and no price reaches the service', async () => {
      const seen: Record<string, unknown>[] = [];
      const app = await build(
        deps({
          openPosition: async (_p, input) => {
            seen.push(input as unknown as Record<string, unknown>);
            return { id: 'pos-1', symbol: input.symbol } as never;
          },
        }),
      );
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/positions',
        headers: signedHeaders(),
        payload: { clientOpenId: 'rest-test-open', symbol: 'BTC/USDT-PERP', side: 'long', size: '1', leverage: '10' },
      });
      expect(res.statusCode).toBe(200);
      expect(seen).toHaveLength(1);
      for (const forbidden of ['entryPrice', 'exitPrice', 'price', 'markPrice']) {
        expect(seen[0]).not.toHaveProperty(forbidden);
      }
      await app.close();
    });

    it('POST /positions forwards clientOpenId (and clientPositionId alias) for retry-safe open', async () => {
      const seen: string[] = [];
      const app = await build(
        deps({
          openPosition: async (_p, input) => {
            seen.push(input.clientOpenId ?? '');
            return { id: 'pos-1', symbol: input.symbol } as never;
          },
        }),
      );
      const a = await app.inject({
        method: 'POST',
        url: '/api/v1/positions',
        headers: signedHeaders(),
        payload: { symbol: 'BTC/USDT-PERP', side: 'long', size: '1', leverage: '5', clientOpenId: 'intent-1' },
      });
      expect(a.statusCode).toBe(200);
      const b = await app.inject({
        method: 'POST',
        url: '/api/v1/positions',
        headers: signedHeaders(),
        payload: { symbol: 'BTC/USDT-PERP', side: 'long', size: '1', leverage: '5', clientPositionId: 'intent-2' },
      });
      expect(b.statusCode).toBe(200);
      expect(seen).toEqual(['intent-1', 'intent-2']);
      await app.close();
    });

    it('POST /positions without clientOpenId → 400 and openPosition is never called', async () => {
      let called = false;
      const app = await build(
        deps({
          openPosition: async () => {
            called = true;
            return { id: 'pos-1' } as never;
          },
        }),
      );
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/positions',
        headers: signedHeaders(),
        payload: { symbol: 'BTC/USDT-PERP', side: 'long', size: '1', leverage: '5' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().intafacedCode).toBe('trade.client_open_id_required');
      expect(called).toBe(false);
      await app.close();
    });

    it('POST /positions without leverage → 400 and openPosition is never called (no silent 1x)', async () => {
      let called = false;
      const app = await build(
        deps({
          openPosition: async () => {
            called = true;
            return { id: 'pos-1' } as never;
          },
        }),
      );
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/positions',
        headers: signedHeaders(),
        payload: { clientOpenId: 'rest-test-open', symbol: 'BTC/USDT-PERP', side: 'long', size: '1' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().intafacedCode).toBe('trade.leverage_required');
      expect(called).toBe(false);
      await app.close();
    });

    it('POST /positions unnamed profit pot is NotSupported, not a 5xx retry', async () => {
      const app = await build(
        deps({
          openPosition: async () => {
            throw new FuturesError('no pot', 'trade.futures_unconfigured', 403);
          },
        }),
      );
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/positions',
        headers: signedHeaders(),
        payload: {
          clientOpenId: 'rest-test-unconfigured',
          symbol: 'BTC/USDT-PERP',
          side: 'long',
          size: '1',
          leverage: '5',
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        error: 'trade.futures_unconfigured',
        ccxtCode: 'NotSupported',
        retry: false,
      });
      await app.close();
    });

    it('POST /positions with numeric leverage is refused, not coerced to 1x', async () => {
      let called = false;
      const app = await build(
        deps({
          openPosition: async () => {
            called = true;
            return { id: 'pos-1' } as never;
          },
        }),
      );
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/positions',
        headers: signedHeaders(),
        payload: { clientOpenId: 'rest-test-open', symbol: 'BTC/USDT-PERP', side: 'long', size: '1', leverage: 10 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().intafacedCode).toBe('trade.leverage_required');
      expect(called).toBe(false);
      await app.close();
    });

    it('an unauthenticated caller is still refused first — the price check does not open a hole', async () => {
      const app = await build();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/positions',
        payload: { clientOpenId: 'rest-test-open', symbol: 'BTC/USDT-PERP', side: 'long', size: '1', entryPrice: '1' },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });

  // ── Isolated margin only (DIRECTION §1, ADR done bar 8) ─────────────────────

  describe('cross margin is refused, not coerced', () => {
    it('POST /positions with marginMode cross → 400, and openPosition is never called', async () => {
      let called = false;
      const app = await build(
        deps({
          openPosition: async () => {
            called = true;
            throw new Error('should not open a cross-margin position');
          },
        }),
      );
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/positions',
        headers: signedHeaders(),
        payload: { clientOpenId: 'rest-test-open', symbol: 'BTC/USDT-PERP', side: 'long', size: '1', leverage: '10', marginMode: 'cross' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('trade.cross_margin_unsupported');
      expect(called).toBe(false);
      await app.close();
    });

    /**
     * The dangerous shape: accepting `cross` and quietly writing `isolated`.
     * The caller believes their whole balance backs the position. It does not.
     */
    it('does not silently downgrade cross to isolated', async () => {
      const seen: unknown[] = [];
      const app = await build(
        deps({
          openPosition: async (_p, input) => {
            seen.push(input.marginMode);
            return {} as never;
          },
        }),
      );
      await app.inject({
        method: 'POST',
        url: '/api/v1/positions',
        headers: signedHeaders(),
        payload: { clientOpenId: 'rest-test-open', symbol: 'BTC/USDT-PERP', side: 'long', size: '1', marginMode: 'cross' },
      });
      expect(seen).toEqual([]);
      await app.close();
    });

    it('still accepts isolated, and omitting it', async () => {
      const seen: unknown[] = [];
      const app = await build(
        deps({
          openPosition: async (_p, input) => {
            seen.push(input.marginMode);
            return {} as never;
          },
        }),
      );
      for (const payload of [
        { symbol: 'BTC/USDT-PERP', side: 'long', size: '1', leverage: '10', marginMode: 'isolated', clientOpenId: 'iso-1' },
        { symbol: 'BTC/USDT-PERP', side: 'long', size: '1', leverage: '10', clientOpenId: 'iso-2' },
      ]) {
        const res = await app.inject({ method: 'POST', url: '/api/v1/positions', headers: signedHeaders(), payload });
        expect(res.statusCode).toBe(200);
      }
      expect(seen).toEqual(['isolated', undefined]);
      await app.close();
    });

    it('refuses an unrecognised margin mode rather than defaulting it', async () => {
      const app = await build();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/positions',
        headers: signedHeaders(),
        payload: {
          clientOpenId: 'rest-test-open',
          symbol: 'BTC/USDT-PERP',
          side: 'long',
          size: '1',
          leverage: '10',
          marginMode: 'portfolio',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('trade.portfolio_margin_unset');
      await app.close();
    });

    it('refuses named cash and yield-bearing collateral on open', async () => {
      let called = false;
      const app = await build(
        deps({
          openPosition: async () => {
            called = true;
            throw new Error('should not open');
          },
        }),
      );
      const cash = await app.inject({
        method: 'POST',
        url: '/api/v1/positions',
        headers: signedHeaders(),
        payload: {
          clientOpenId: 'rest-test-open-cash',
          symbol: 'BTC/USDT-PERP',
          side: 'long',
          size: '1',
          leverage: '10',
          marginMode: 'cash',
        },
      });
      expect(cash.statusCode).toBe(400);
      expect(cash.json().error).toBe('trade.cash_margin_unsupported');
      const yieldIm = await app.inject({
        method: 'POST',
        url: '/api/v1/positions',
        headers: signedHeaders(),
        payload: {
          clientOpenId: 'rest-test-open-yield',
          symbol: 'BTC/USDT-PERP',
          side: 'long',
          size: '1',
          leverage: '10',
          marginMode: 'isolated',
          collateralClass: 'yield_bearing',
        },
      });
      expect(yieldIm.statusCode).toBe(400);
      expect(yieldIm.json().error).toBe('trade.unsupported_collateral_class');
      expect(called).toBe(false);
      await app.close();
    });
  });

  describe('crossMarginRefusal', () => {
    it('passes isolated and undefined, refuses named and unknown modes', () => {
      expect(crossMarginRefusal(undefined)).toBeNull();
      expect(crossMarginRefusal('isolated')).toBeNull();
      expect(crossMarginRefusal('cross')?.error).toBe('trade.cross_margin_unsupported');
      expect(crossMarginRefusal('portfolio')?.error).toBe('trade.portfolio_margin_unset');
      expect(crossMarginRefusal('cash')?.error).toBe('trade.cash_margin_unsupported');
      expect(crossMarginRefusal('CROSS')?.error).toBe('trade.margin_mode_unknown');
      expect(crossMarginRefusal(null)?.error).toBe('trade.margin_mode_unset');
    });

    it('explains why coercion would be worse than refusal', () => {
      expect(crossMarginRefusal('cross')!.message).toContain('misreport what is backing it');
    });
  });

  describe('suppliedPriceFields', () => {
    it('finds every forbidden field a request carries, and nothing else', () => {
      expect(suppliedPriceFields({ symbol: 'BTC/USDT', size: '1' })).toEqual([]);
      expect(suppliedPriceFields({ entryPrice: '1', exitPrice: '2' })).toEqual(['entryPrice', 'exitPrice']);
      expect(suppliedPriceFields(null)).toEqual([]);
      expect(suppliedPriceFields(undefined)).toEqual([]);
    });

    it('catches an EMPTY price too — sending the field at all is the mistake', () => {
      expect(suppliedPriceFields({ exitPrice: '' })).toEqual(['exitPrice']);
      expect(suppliedPriceFields({ entryPrice: null })).toEqual(['entryPrice']);
    });
  });

  // ── setLeverage / setMarginMode ───────────────────────────────────────────

  const fakeLeveredPosition = {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    symbol: 'BTC/USDT-PERP',
    timestamp: Date.parse('2026-08-06T12:00:00.000Z'),
    datetime: '2026-08-06T12:00:00.000Z',
    side: 'long' as const,
    status: 'open' as const,
    closingReason: null,
    contracts: '1',
    contractSize: null,
    entryPrice: '50000',
    markPrice: null,
    notional: '50000',
    leverage: '5',
    collateral: '10000',
    initialMargin: '10000',
    maintenanceMargin: null,
    unrealizedPnl: null,
    realizedPnl: null,
    liquidationPrice: null,
    marginMode: 'isolated' as const,
    percentage: null,
  };

  it('POST /positions/leverage: signed in-cap change → 200 (never a blanket 501)', async () => {
    let called: { symbol: string; leverage: string } | undefined;
    const app = await build(
      deps({
        setLeverage: async (_p, input) => {
          called = input;
          return { ...fakeLeveredPosition, leverage: input.leverage };
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/leverage',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: { symbol: 'BTC/USDT-PERP', positionId: 'pos-1', leverage: '5', clientAdjustmentId: 'lev-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(called).toEqual({ symbol: 'BTC/USDT-PERP', leverage: '5', positionId: 'pos-1', clientAdjustmentId: 'lev-1' });
    expect(res.json().leverage).toBe('5');
    await app.close();
  });

  it('POST /positions/leverage: refuses a missing durable caller key before the money dependency', async () => {
    let called = false;
    const app = await build(
      deps({
        setLeverage: async () => {
          called = true;
          return fakeLeveredPosition;
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/leverage',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: { symbol: 'BTC/USDT-PERP', positionId: 'pos-1', leverage: '5' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().intafacedCode).toBe('trade.idempotency_key_required');
    expect(called).toBe(false);
    await app.close();
  });

  it('POST /positions/margin: signed add → 200 and does not change leverage on the dep input', async () => {
    let called: { symbol: string; amount: string } | undefined;
    const app = await build(
      deps({
        addIsolatedMargin: async (_p, input) => {
          called = input;
          return { ...fakeLeveredPosition, collateral: '12500' };
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/margin',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: { symbol: 'BTC/USDT-PERP', positionId: 'pos-1', amount: '2500', clientAdjustmentId: 'add-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(called).toEqual({ symbol: 'BTC/USDT-PERP', amount: '2500', positionId: 'pos-1', clientAdjustmentId: 'add-1' });
    expect(res.json().collateral).toBe('12500');
    await app.close();
  });

  it('POST /positions/margin: yield-bearing collateral → 400 before the dep', async () => {
    let called = false;
    const app = await build(
      deps({
        addIsolatedMargin: async () => {
          called = true;
          return fakeLeveredPosition;
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/margin',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: {
        symbol: 'BTC/USDT-PERP',
        positionId: 'pos-1',
        amount: '2500',
        clientAdjustmentId: 'add-yield',
        collateralClass: 'yield_bearing',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('trade.unsupported_collateral_class');
    expect(called).toBe(false);
    await app.close();
  });

  it('POST /positions/margin: JSON number amount → 400 before the dep', async () => {
    let called = false;
    const app = await build(
      deps({
        addIsolatedMargin: async () => {
          called = true;
          return fakeLeveredPosition;
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/margin',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: { symbol: 'BTC/USDT-PERP', amount: 2500 },
    });
    expect(res.statusCode).toBe(400);
    expect(called).toBe(false);
    await app.close();
  });

  it('POST /positions/margin: insufficient → 400 without treating it as success', async () => {
    const app = await build(
      deps({
        addIsolatedMargin: async () => {
          throw new FuturesError('need extra isolated margin', 'trade.insufficient_margin', 400);
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/margin',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: { symbol: 'BTC/USDT-PERP', positionId: 'pos-1', amount: '2500', clientAdjustmentId: 'add-insufficient' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('trade.insufficient_margin');
    await app.close();
  });

  it('POST /positions/margin/reduce: signed reduce → 200', async () => {
    let called: { symbol: string; amount: string } | undefined;
    const app = await build(
      deps({
        reduceIsolatedMargin: async (_p, input) => {
          called = input;
          return { ...fakeLeveredPosition, collateral: '5000' };
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/margin/reduce',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: { symbol: 'BTC/USDT-PERP', positionId: 'pos-1', amount: '2500', clientAdjustmentId: 'reduce-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(called).toEqual({ symbol: 'BTC/USDT-PERP', amount: '2500', positionId: 'pos-1', clientAdjustmentId: 'reduce-1' });
    expect(res.json().collateral).toBe('5000');
    await app.close();
  });

  it('POST /positions/margin/reduce: below initial → 400 without treating it as success', async () => {
    const app = await build(
      deps({
        reduceIsolatedMargin: async () => {
          throw new FuturesError('below initial', 'trade.margin_below_initial', 400);
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/margin/reduce',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: { symbol: 'BTC/USDT-PERP', positionId: 'pos-1', amount: '2500', clientAdjustmentId: 'reduce-below' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('trade.margin_below_initial');
    await app.close();
  });

  it('POST /positions/leverage: missing position → 404 and is the only write path (dep threw)', async () => {
    const app = await build(
      deps({
        setLeverage: async () => {
          throw new FuturesError('no open position on BTC/USDT-PERP', 'trade.position_not_found', 404);
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/leverage',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: { symbol: 'BTC/USDT-PERP', positionId: 'pos-missing', leverage: '5', clientAdjustmentId: 'lev-missing' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('trade.position_not_found');
    await app.close();
  });

  it('POST /positions/leverage: >10× → 400 trade.leverage_too_high', async () => {
    const app = await build(
      deps({
        setLeverage: async () => {
          throw new FuturesError('leverage 11x exceeds the maximum of 10x on this deployment', 'trade.leverage_too_high', 400);
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/leverage',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: { symbol: 'BTC/USDT-PERP', positionId: 'pos-1', leverage: '11', clientAdjustmentId: 'lev-high' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('trade.leverage_too_high');
    await app.close();
  });

  it('POST /positions/leverage: would-be liquidation → 400 without treating it as success', async () => {
    const app = await build(
      deps({
        setLeverage: async () => {
          throw new FuturesError('refusing leverage 10x', 'trade.leverage_would_liquidate', 400);
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/leverage',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: { symbol: 'BTC/USDT-PERP', positionId: 'pos-1', leverage: '10', clientAdjustmentId: 'lev-liquidate' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.statusCode).not.toBe(200);
    expect(res.json().error).toBe('trade.leverage_would_liquidate');
    await app.close();
  });

  it('POST /positions/leverage: insufficient margin → 400 without treating it as success', async () => {
    const app = await build(
      deps({
        setLeverage: async () => {
          throw new FuturesError('need extra isolated margin', 'trade.insufficient_margin', 400);
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/leverage',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: { symbol: 'BTC/USDT-PERP', positionId: 'pos-1', leverage: '1', clientAdjustmentId: 'lev-insufficient' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.statusCode).not.toBe(200);
    expect(res.json().error).toBe('trade.insufficient_margin');
    await app.close();
  });

  it('POST /positions/margin-mode: signed → 501 NotSupported (isolated-at-open only)', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/margin-mode',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: { symbol: 'BTC/USDT', marginMode: 'cross' },
    });
    expect(res.statusCode).not.toBe(200);
    expect(res.statusCode).toBe(501);
    expect(res.json().code).toBe('NotSupported');
    expect(res.json().intafacedCode).toBe('trade.margin_mode_unsupported');
    expect(res.json().retryAfter).toBeUndefined();
    await app.close();
  });

  for (const path of [
    '/api/v1/positions/leverage',
    '/api/v1/positions/margin',
    '/api/v1/positions/margin/reduce',
    '/api/v1/positions/margin-mode',
  ] as const) {
    it(`POST ${path}: anonymous → 401 (capabilities are not enumerable unauthenticated)`, async () => {
      const app = await build();
      const res = await app.inject({
        method: 'POST',
        url: path,
        headers: { 'content-type': 'application/json' },
        payload: { symbol: 'BTC/USDT' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('AuthenticationError');
      await app.close();
    });

    it(`POST ${path}: scope miss → 403 before the capability answer`, async () => {
      const app = await build();
      const res = await app.inject({
        method: 'POST',
        url: path,
        headers: { ...signedHeaders(principal({ scopes: ['trade:read'] })), 'content-type': 'application/json' },
        payload: { symbol: 'BTC/USDT' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('PermissionDenied');
      await app.close();
    });
  }

  it('GET /positions?symbol=: still returns [] (filter accepted, no invent)', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/positions?symbol=BTC%2FUSDT',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });
});
