/**
 * R-fx public doors — FX separate from spot book; holiday/rail named degrade.
 *
 * Done bar:
 *   · GET forex.productStatus names convert=refused + unpublished holiday + rail socket
 *   · GET /api/v1/markets EUR/USD: product=fx, orderable=false, degrade named
 *   · convert.quote paper FX weekday → trade.fx_not_spot, inventMid never called
 *   · POST /api/v1/orders paper FX weekday → holiday calendar unpublished, no hold
 *   · crypto convert/place unchanged
 *
 * Do not dual-implement convert. Do not invent FX mids.
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { createTradeRouter } from '../router.js';
import { fakeMarket, registerPublicRest } from '../public-rest.js';
import { fakeOrder, registerPrivateRest, type PrivateRestDeps } from '../private-rest.js';
import { assertMarketOpen, assertSettlementRails, assertSpotSurface, assertTradable } from './risk.js';
import { FOREX_SETTLEMENT_SOCKET } from './forex-settlement.js';
import { FX_HOLIDAY_CALENDAR_UNPUBLISHED_CODE } from './fx-product.js';
import { TradeError, type Market, type OrderType } from './types.js';
import type { ConvertQuoteRequest, PlaceOrderInput, TradeService } from './trade-service.js';

const EDGE_SECRET = 'a-trade-r-fx-separate-public-door-edge-secret-32';
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '33333333-3333-4333-8333-333333333333';
const WEDNESDAY_UTC = new Date('2026-01-14T12:00:00Z');
const edgeContext = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-trade' });

type WireBody = {
  result?: { data?: unknown };
  error?: { message?: string; data?: { code?: string; httpStatus?: number } };
};

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

function paperFx(overrides: Partial<Market> = {}): Market {
  return fakeMarket({
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
    ...overrides,
  });
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

/** Same pre-hold stack as TradeService.placeOrderInner: tradable → rails → hours. */
function gatedPlaceOrder(opts: {
  marketBySymbol: (symbol: string) => Promise<Market | null>;
  now: () => Date;
  fundHold: () => void;
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
    opts.fundHold();
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

/** Same convert stack as buildConvertQuote before depth walk. */
function gatedConvertQuote(opts: {
  marketBySymbol: (symbol: string) => Promise<Market | null>;
  now: () => Date;
  inventMid: () => void;
}): (principal: Principal, input: ConvertQuoteRequest) => Promise<never> {
  return async (_principal, input) => {
    const symbol = input.symbol;
    if (!symbol) {
      throw new TradeError('market symbol required', 'trade.market_not_found');
    }
    const market = await opts.marketBySymbol(symbol);
    if (!market) {
      throw new TradeError(`market ${symbol} not found`, 'trade.market_not_found');
    }
    assertSpotSurface(market, 'convert');
    assertTradable(market);
    assertSettlementRails(market);
    assertMarketOpen(market, opts.now());
    opts.inventMid();
    throw new Error('convert must not invent an FX mid');
  };
}

async function getTrpc(
  app: ReturnType<typeof Fastify>,
  path: string,
  input: Record<string, unknown> = {},
): Promise<{ statusCode: number; body: WireBody }> {
  const qs = Object.keys(input).length === 0 ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.inject({ method: 'GET', url: `/trpc/${path}${qs}`, headers: signedHeaders() });
  return { statusCode: res.statusCode, body: res.json() as WireBody };
}

describe('R-fx public doors — FX separate, holiday/rail named', () => {
  it('GET forex.productStatus names convert refuse + holiday/rail degrade', async () => {
    const router = createTradeRouter({} as unknown as TradeService);
    const app = Fastify({ logger: false });
    await app.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: {
        router,
        createContext: ({ req }) => edgeContext(req),
      } satisfies FastifyTRPCPluginOptions<typeof router>['trpcOptions'],
    });
    await app.ready();

    const { statusCode, body } = await getTrpc(app, 'forex.productStatus');
    expect(statusCode).toBe(200);
    const payload = (body.result?.data ?? body.result) as {
      product?: string;
      convert?: string;
      matching?: string;
      holidayCalendar?: { published?: boolean };
      rail?: { socket?: string; published?: boolean };
    };
    expect(payload.product).toBe('fx');
    expect(payload.convert).toBe('refused');
    expect(payload.matching).toBe('not_spot_book');
    expect(payload.holidayCalendar?.published).toBe(false);
    expect(payload.rail?.published).toBe(false);
    expect(payload.rail?.socket).toBe(FOREX_SETTLEMENT_SOCKET);
    await app.close();
  });

  it('GET /api/v1/markets: EUR/USD is FX product, not orderable, degrade named', async () => {
    const eurusd = paperFx({ paper: false });
    const app = Fastify({ logger: false });
    registerPublicRest(app, {
      markets: async () => [eurusd],
      marketBySymbol: async (s) => (s === eurusd.symbol ? eurusd : null),
      depth: async () => ({ bids: [], asks: [], sequence: 0 }),
      publicTape: async () => [],
      candles: async () => [],
      now: () => WEDNESDAY_UTC.getTime(),
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/v1/markets?limit=50' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{
      symbol: string;
      assetClass?: string;
      product?: string;
      orderable?: boolean;
      sessionOpen?: boolean;
      degrade?: { convert?: string; holidayCalendar?: { published?: boolean }; rail?: { socket?: string } };
    }>;
    const wire = body.find((m) => m.symbol === 'EUR/USD');
    expect(wire?.assetClass).toBe('forex');
    expect(wire?.product).toBe('fx');
    expect(wire?.orderable).toBe(false);
    expect(wire?.sessionOpen).toBe(true);
    expect(wire?.degrade?.convert).toBe('refused');
    expect(wire?.degrade?.holidayCalendar?.published).toBe(false);
    expect(wire?.degrade?.rail?.socket).toBe(FOREX_SETTLEMENT_SOCKET);
    await app.close();
  });

  it('GET convert.quote: paper FX weekday refuses before inventing a mid', async () => {
    const inventMid = vi.fn();
    const eurusd = paperFx();
    const convertQuote = vi.fn(
      gatedConvertQuote({
        marketBySymbol: async (s) => (s === eurusd.symbol ? eurusd : null),
        now: () => WEDNESDAY_UTC,
        inventMid,
      }),
    );
    const router = createTradeRouter({ convertQuote } as unknown as TradeService);
    const app = Fastify({ logger: false });
    await app.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: {
        router,
        createContext: ({ req }) => edgeContext(req),
      } satisfies FastifyTRPCPluginOptions<typeof router>['trpcOptions'],
    });
    await app.ready();

    const { statusCode, body } = await getTrpc(app, 'convert.quote', {
      symbol: 'EUR/USD',
      side: 'buy',
      qty: '1000',
    });

    expect(statusCode).toBe(403);
    expect(String(body.error?.message ?? '')).toMatch(/trade\.fx_not_spot|FX product/i);
    expect(inventMid).not.toHaveBeenCalled();
    expect(convertQuote).toHaveBeenCalled();
    await app.close();
  });

  it('POST /api/v1/orders: paper FX weekday → holiday calendar unpublished, hold never taken', async () => {
    const fundHold = vi.fn();
    const eurusd = paperFx();
    const marketBySymbol = async (s: string) => (s === eurusd.symbol ? eurusd : null);
    const placeOrder = vi.fn(
      gatedPlaceOrder({
        marketBySymbol,
        now: () => WEDNESDAY_UTC,
        fundHold,
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
      payload: {
        symbol: 'EUR/USD',
        type: 'limit',
        side: 'buy',
        amount: '1000',
        price: '1.10',
        clientOrderId: 'r-fx-weekday-eurusd',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().intafacedCode).toBe(FX_HOLIDAY_CALENDAR_UNPUBLISHED_CODE);
    expect(fundHold).not.toHaveBeenCalled();
    expect(placeOrder).toHaveBeenCalled();
    await app.close();
  });

  it('POST /api/v1/orders: crypto weekday still clears FX gates', async () => {
    const fundHold = vi.fn();
    const btc = fakeMarket({ assetClass: 'crypto', schedule: 'crypto-24x7', paper: false });
    const marketBySymbol = async (s: string) => (s === btc.symbol ? btc : null);
    const placeOrder = vi.fn(
      gatedPlaceOrder({
        marketBySymbol,
        now: () => WEDNESDAY_UTC,
        fundHold,
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
      payload: {
        symbol: 'BTC/USDT',
        type: 'limit',
        side: 'buy',
        amount: '0.01',
        price: '50000',
        clientOrderId: 'r-fx-crypto-still-spot',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(fundHold).toHaveBeenCalledOnce();
    await app.close();
  });
});
