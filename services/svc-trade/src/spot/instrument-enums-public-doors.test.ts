/**
 * D26-P1-T9 public doors — multi-asset enum authority + closed-venue refuse.
 *
 * Done bar: additive model; closed-venue refuse; spot suite unchanged.
 * Break class: unit-only helpers that never cross mounted Fastify public/
 * private REST (hard-board failure mode: “route exists” / helper-green).
 *
 * Proofs run the REAL order-boundary gates (`assertTradable` →
 * `assertSettlementRails` → `assertMarketOpen` / `requireTradingSchedule`)
 * behind POST /api/v1/orders, plus GET /api/v1/markets sessionOpen from the
 * same `TRADING_SCHEDULES` authority. No stubbed refuse codes.
 *
 * Leverage: registerPublicRest + registerPrivateRest + instrument-enums /
 * risk (Phase A — wire honesty, no second book / SPA).
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { fakeMarket, registerPublicRest } from '../public-rest.js';
import { fakeOrder, registerPrivateRest, type PrivateRestDeps } from '../private-rest.js';
import { assertMarketOpen, assertSettlementRails, assertTradable } from './risk.js';
import { TradeError, type Market, type OrderType } from './types.js';
import type { PlaceOrderInput } from './trade-service.js';

const EDGE_SECRET = 'a-trade-t9-instrument-public-door-edge-secret-32';
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '33333333-3333-4333-8333-333333333333';
const SATURDAY_UTC = new Date('2026-01-10T12:00:00Z');
const WEDNESDAY_UTC = new Date('2026-01-14T12:00:00Z');

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: SESSION,
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signedHeaders(p: Principal = principal()): Record<string, string> {
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

function privateDeps(overrides: Partial<PrivateRestDeps> = {}): PrivateRestDeps {
  return {
    edgeSecret: EDGE_SECRET,
    icebergDisplayRule: null,
    serviceName: 'svc-trade',
    openOrders: async () => [],
    orderHistory: async () => [],
    getOrder: async () => {
      throw new Error('unused');
    },
    placeOrder: async () => {
      throw new Error('unused');
    },
    cancelOrder: async () => {
      throw new Error('unused');
    },
    cancelAllOrders: async () => [],
    massCancelOrders: async () => [],
    myFills: async () => [],
    marketBySymbol: async () => null,
    marketById: async () => null,
    markets: async () => [],
    userBalances: async () => [],
    listPositions: async () => [],
    listClosedPositions: async () => [],
    getPosition: async () => {
      throw new Error('unused');
    },
    openPosition: async () => {
      throw new Error('unused');
    },
    closePosition: async () => {
      throw new Error('unused');
    },
    setLeverage: async () => {
      throw new Error('unused');
    },
    addIsolatedMargin: async () => {
      throw new Error('unused');
    },
    reduceIsolatedMargin: async () => {
      throw new Error('unused');
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

/**
 * Real place path through the same risk stack TradeService.placeOrderInner
 * runs before any hold — enum authority, settlement rails, session open.
 */
function realRiskPlaceOrder(opts: {
  marketBySymbol: (symbol: string) => Promise<Market | null>;
  now: () => Date;
}): (principal: Principal, input: PlaceOrderInput) => Promise<ReturnType<typeof fakeOrder>> {
  return async (_principal, input) => {
    const symbol = input.symbol;
    if (!symbol) {
      throw new TradeError('market symbol required', 'trade.market_not_found');
    }
    const market = await opts.marketBySymbol(symbol);
    if (!market) {
      throw new TradeError(`market ${symbol} not found`, 'trade.market_not_found');
    }
    assertTradable(market);
    assertSettlementRails(market);
    assertMarketOpen(market, opts.now());
    const orderType = input.type as OrderType;
    return fakeOrder({
      marketId: market.id,
      clientOrderId: input.clientOrderId ?? null,
      side: input.side,
      type: orderType,
      qty: input.qty,
      price: input.price ?? null,
    });
  };
}

const orderBody = (symbol: string) => ({
  symbol,
  type: 'limit' as const,
  side: 'buy' as const,
  amount: '0.01',
  price: '50000',
  clientOrderId: `t9-door-${symbol.replace(/[^A-Za-z]/g, '')}`,
});

describe('D26-P1-T9 public doors — additive model + closed-venue + enum refuse', () => {
  it('GET /api/v1/markets: crypto stays sessionOpen on FX weekend; FX is closed (additive)', async () => {
    const btc = fakeMarket({
      id: '00000000-0000-4000-8000-000000000001',
      symbol: 'BTC/USDT',
      schedule: 'crypto-24x7',
      assetClass: 'crypto',
    });
    const eurusd = fakeMarket({
      id: '00000000-0000-4000-8000-000000000002',
      symbol: 'EUR/USD',
      baseAsset: 'EUR',
      quoteAsset: 'USD',
      schedule: 'fx-global',
      assetClass: 'forex',
      paper: true,
      tickSize: parseAmount('0.00001'),
      lotSize: parseAmount('1000'),
      minQty: parseAmount('1000'),
    });

    const app = Fastify({ logger: false });
    registerPublicRest(app, {
      markets: async () => [btc, eurusd],
      marketBySymbol: async (s) => [btc, eurusd].find((m) => m.symbol === s) ?? null,
      depth: async () => ({ bids: [], asks: [], sequence: 0 }),
      publicTape: async () => [],
      candles: async () => [],
      now: () => SATURDAY_UTC.getTime(),
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/v1/markets?limit=50' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ symbol: string; sessionOpen: boolean; schedule: string }>;
    const wireBtc = body.find((m) => m.symbol === 'BTC/USDT');
    const wireFx = body.find((m) => m.symbol === 'EUR/USD');
    expect(wireBtc?.sessionOpen).toBe(true);
    expect(wireBtc?.schedule).toBe('crypto-24x7');
    expect(wireFx?.sessionOpen).toBe(false);
    expect(wireFx?.schedule).toBe('fx-global');
    await app.close();
  });

  it('POST /api/v1/orders: FX weekend → trade.market_closed (503), not unknown_schedule', async () => {
    const eurusd = fakeMarket({
      id: '00000000-0000-4000-8000-000000000002',
      symbol: 'EUR/USD',
      baseAsset: 'EUR',
      quoteAsset: 'USD',
      schedule: 'fx-global',
      assetClass: 'forex',
      // paper: settlement rails stay quiet so the session gate is what we prove
      paper: true,
      tickSize: parseAmount('0.00001'),
      lotSize: parseAmount('1000'),
      minQty: parseAmount('1000'),
    });
    const marketBySymbol = async (s: string) => (s === eurusd.symbol ? eurusd : null);
    const placeOrder = vi.fn(
      realRiskPlaceOrder({
        marketBySymbol,
        now: () => SATURDAY_UTC,
      }),
    );

    const app = Fastify({ logger: false });
    registerPrivateRest(
      app,
      privateDeps({
        placeOrder,
        marketBySymbol,
        marketById: async (id) => (id === eurusd.id ? eurusd : null),
      }),
    );
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { 'content-type': 'application/json', ...signedHeaders() },
      payload: { ...orderBody('EUR/USD'), amount: '1000', price: '1.10' },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('ExchangeNotAvailable');
    expect(res.json().intafacedCode).toBe('trade.market_closed');
    expect(placeOrder).toHaveBeenCalled();
    await app.close();
  });

  it('POST /api/v1/orders: unknown schedule → trade.unknown_schedule (400), never Monday-retry', async () => {
    const drifted = fakeMarket({
      id: '00000000-0000-4000-8000-000000000003',
      symbol: 'ACME/USD',
      schedule: 'lse-equities' as Market['schedule'],
      assetClass: 'crypto',
    });
    const marketBySymbol = async (s: string) => (s === drifted.symbol ? drifted : null);
    const placeOrder = vi.fn(
      realRiskPlaceOrder({
        marketBySymbol,
        now: () => WEDNESDAY_UTC,
      }),
    );

    const app = Fastify({ logger: false });
    registerPrivateRest(
      app,
      privateDeps({
        placeOrder,
        marketBySymbol,
        marketById: async (id) => (id === drifted.id ? drifted : null),
      }),
    );
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { 'content-type': 'application/json', ...signedHeaders() },
      payload: orderBody('ACME/USD'),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BadRequest');
    expect(res.json().intafacedCode).toBe('trade.unknown_schedule');
    expect(String(res.json().message ?? res.json().info ?? '')).toMatch(/lse-equities|crypto-24x7|fx-global/);
    expect(placeOrder).toHaveBeenCalled();
    await app.close();
  });

  it('POST /api/v1/orders: unknown asset_class → trade.unknown_asset_class before any hold', async () => {
    const drifted = fakeMarket({
      id: '00000000-0000-4000-8000-000000000004',
      symbol: 'EQ/USD',
      schedule: 'crypto-24x7',
      assetClass: 'equity' as Market['assetClass'],
    });
    const marketBySymbol = async (s: string) => (s === drifted.symbol ? drifted : null);
    const placeOrder = vi.fn(
      realRiskPlaceOrder({
        marketBySymbol,
        now: () => WEDNESDAY_UTC,
      }),
    );

    const app = Fastify({ logger: false });
    registerPrivateRest(
      app,
      privateDeps({
        placeOrder,
        marketBySymbol,
        marketById: async (id) => (id === drifted.id ? drifted : null),
      }),
    );
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { 'content-type': 'application/json', ...signedHeaders() },
      payload: orderBody('EQ/USD'),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BadRequest');
    expect(res.json().intafacedCode).toBe('trade.unknown_asset_class');
    expect(placeOrder).toHaveBeenCalled();
    await app.close();
  });

  it('POST /api/v1/orders: crypto on FX weekend clears risk gates (additive spot bar)', async () => {
    const btc = fakeMarket({
      id: '00000000-0000-4000-8000-000000000001',
      symbol: 'BTC/USDT',
      schedule: 'crypto-24x7',
      assetClass: 'crypto',
    });
    const marketBySymbol = async (s: string) => (s === btc.symbol ? btc : null);
    const placeOrder = vi.fn(
      realRiskPlaceOrder({
        marketBySymbol,
        now: () => SATURDAY_UTC,
      }),
    );

    const app = Fastify({ logger: false });
    registerPrivateRest(
      app,
      privateDeps({
        placeOrder,
        marketBySymbol,
        marketById: async (id) => (id === btc.id ? btc : null),
      }),
    );
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { 'content-type': 'application/json', ...signedHeaders() },
      payload: orderBody('BTC/USDT'),
    });

    expect(res.statusCode).toBe(201);
    expect(placeOrder).toHaveBeenCalled();
    expect(res.json().symbol).toBe('BTC/USDT');
    await app.close();
  });
});
