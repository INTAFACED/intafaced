/**
 * TRK-trade.forex hours/refuse public doors.
 *
 * Done bar: weekend / closed / unrecognised schedule → typed refuse on mounted
 * Fastify private REST + convert.quote tRPC, with NO funded hold and no invented
 * FX mid. Break class: helper-only assertMarketOpen that never crosses a door.
 *
 * Leverage: registerPrivateRest + createTradeRouter + existing assertMarketOpen
 * / requireTradingSchedule (Phase A — extend svc-trade hours; no second book,
 * no production fiat pair list, no invented mids).
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
import { assertMarketOpen, assertSettlementRails, assertTradable } from './risk.js';
import { TradeError, type Market, type OrderType } from './types.js';
import type { ConvertQuoteRequest, PlaceOrderInput, TradeService } from './trade-service.js';

const EDGE_SECRET = 'a-trade-forex-hours-public-door-edge-secret-32';
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '33333333-3333-4333-8333-333333333333';
const SATURDAY_UTC = new Date('2026-01-10T12:00:00Z');
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

/**
 * Same pre-hold stack as TradeService.placeOrderInner: tradable → rails → hours.
 * `fundHold` is the ledger orderHold stand-in — must stay at zero on refuse.
 */
function hoursGatedPlaceOrder(opts: {
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

function hoursGatedConvertQuote(opts: {
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
    assertTradable(market);
    assertSettlementRails(market);
    assertMarketOpen(market, opts.now());
    opts.inventMid();
    throw new Error('convert must not invent an FX mid after hours refuse');
  };
}

async function mountOrders(opts: { market: Market; now: () => Date; fundHold: () => void }): Promise<ReturnType<typeof Fastify>> {
  const marketBySymbol = async (s: string) => (s === opts.market.symbol ? opts.market : null);
  const placeOrder = vi.fn(
    hoursGatedPlaceOrder({
      marketBySymbol,
      now: opts.now,
      fundHold: opts.fundHold,
    }),
  );
  const app = Fastify({ logger: false });
  registerPrivateRest(
    app,
    privateDeps({
      placeOrder,
      marketBySymbol,
      marketById: async (id) => (id === opts.market.id ? opts.market : null),
    }),
  );
  await app.ready();
  return app;
}

async function getTrpc(
  app: ReturnType<typeof Fastify>,
  path: string,
  input: Record<string, unknown>,
): Promise<{ statusCode: number; body: WireBody }> {
  const qs = `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.inject({ method: 'GET', url: `/trpc/${path}${qs}`, headers: signedHeaders() });
  return { statusCode: res.statusCode, body: res.json() as WireBody };
}

describe('TRK-trade.forex hours/refuse public doors — no funded hold', () => {
  it('POST /api/v1/orders: FX weekend → trade.market_closed, hold never taken', async () => {
    const fundHold = vi.fn();
    const app = await mountOrders({
      market: paperFx(),
      now: () => SATURDAY_UTC,
      fundHold,
    });

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
        clientOrderId: 'hours-weekend-eurusd',
      },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().intafacedCode).toBe('trade.market_closed');
    expect(fundHold).not.toHaveBeenCalled();
    await app.close();
  });

  it('POST /api/v1/orders: unrecognised schedule → trade.unknown_schedule, hold never taken', async () => {
    const fundHold = vi.fn();
    const drifted = fakeMarket({
      id: '00000000-0000-4000-8000-000000000003',
      symbol: 'ACME/USD',
      schedule: 'lse-equities' as Market['schedule'],
      assetClass: 'crypto',
      paper: false,
    });
    const app = await mountOrders({
      market: drifted,
      now: () => WEDNESDAY_UTC,
      fundHold,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { 'content-type': 'application/json', ...signedHeaders() },
      payload: {
        symbol: 'ACME/USD',
        type: 'limit',
        side: 'buy',
        amount: '0.01',
        price: '50000',
        clientOrderId: 'hours-unknown-schedule',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().intafacedCode).toBe('trade.unknown_schedule');
    expect(fundHold).not.toHaveBeenCalled();
    await app.close();
  });

  it('GET convert.quote: FX weekend refuses before inventing a mid', async () => {
    const inventMid = vi.fn();
    const eurusd = paperFx();
    const convertQuote = vi.fn(
      hoursGatedConvertQuote({
        marketBySymbol: async (s) => (s === eurusd.symbol ? eurusd : null),
        now: () => SATURDAY_UTC,
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

    expect([400, 503]).toContain(statusCode);
    expect(String(body.error?.message ?? '')).toMatch(/trade\.market_closed|is closed/i);
    expect(inventMid).not.toHaveBeenCalled();
    expect(convertQuote).toHaveBeenCalled();
    await app.close();
  });

  it('GET /api/v1/markets: unrecognised schedule is sessionOpen=false (never invent hours)', async () => {
    const drifted = fakeMarket({
      id: '00000000-0000-4000-8000-000000000003',
      symbol: 'ACME/USD',
      schedule: 'lse-equities' as Market['schedule'],
      assetClass: 'crypto',
    });
    const app = Fastify({ logger: false });
    registerPublicRest(app, {
      markets: async () => [drifted],
      marketBySymbol: async (s) => (s === drifted.symbol ? drifted : null),
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
      sessionOpen: boolean;
      schedule: string;
      hours?: { kind: string };
    }>;
    const wire = body.find((m) => m.symbol === 'ACME/USD');
    expect(wire?.sessionOpen).toBe(false);
    expect(wire?.schedule).toBe('lse-equities');
    expect(wire?.hours?.kind).not.toBe('continuous');
    await app.close();
  });
});
