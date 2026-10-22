/**
 * D26-P1-T7 public doors — COMPLETE refuse-closed forex product.
 *
 * Done bar (until P0-05 + fiat rails): explicit socket/refuse on public doors,
 * never invent settlement asset. Break class: one-liner status query or
 * helper-only asserts that never cross mounted Fastify+tRPC / private REST.
 *
 * Proofs:
 *   · GET forex.settlementStatus → published=false, socket + blockers named
 *   · POST forex.assertProductionListing → production FX refuse on wire
 *   · POST /api/v1/orders → REAL assertSettlementRails refuse (no stub code)
 *   · crypto / paper paths stay open (honest residual, not blanket kill)
 *
 * Leverage: createTradeRouter + registerPrivateRest + forex-settlement
 * (Phase A — extend refuse surface; no second book / invent FX prices).
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { createTradeRouter } from '../router.js';
import { fakeMarket } from '../public-rest.js';
import { fakeOrder, registerPrivateRest, type PrivateRestDeps } from '../private-rest.js';
import { assertSettlementRails, assertTradable } from './risk.js';
import { FOREX_SETTLEMENT_REFUSE_CODE, FOREX_SETTLEMENT_SOCKET, assertProductionUnsettledAssetClassListing } from './forex-settlement.js';
import { TradeError, type Market, type OrderType } from './types.js';
import type { PlaceOrderInput } from './trade-service.js';
import type { TradeService } from './trade-service.js';

const EDGE_SECRET = 'a-trade-t7-forex-public-door-edge-secret-32b';
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '33333333-3333-4333-8333-333333333333';
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

function stubTrade(overrides: Partial<TradeService> = {}): TradeService {
  return {
    markets: async () => [],
    marketBySymbol: async () => null,
    ...overrides,
  } as unknown as TradeService;
}

async function mountTrpc(trade: TradeService = stubTrade()): Promise<ReturnType<typeof Fastify>> {
  const router = createTradeRouter(trade);
  const app = Fastify({ logger: false });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router,
      createContext: ({ req }) => edgeContext(req),
    } satisfies FastifyTRPCPluginOptions<typeof router>['trpcOptions'],
  });
  await app.ready();
  return app;
}

async function getTrpc(
  app: ReturnType<typeof Fastify>,
  path: string,
  input: Record<string, unknown> = {},
  headers: Record<string, string> = signedHeaders(),
): Promise<{ statusCode: number; body: WireBody }> {
  const qs = `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.inject({ method: 'GET', url: `/trpc/${path}${qs}`, headers });
  return { statusCode: res.statusCode, body: res.json() as WireBody };
}

async function postTrpc(
  app: ReturnType<typeof Fastify>,
  path: string,
  input: Record<string, unknown>,
  headers: Record<string, string> = signedHeaders(),
): Promise<{ statusCode: number; body: WireBody }> {
  const res = await app.inject({
    method: 'POST',
    url: `/trpc/${path}`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: input,
  });
  return { statusCode: res.statusCode, body: res.json() as WireBody };
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

/** Real place-path seal: tradable + settlement rails (no invented hold). */
function realSettlementPlaceOrder(opts: {
  marketBySymbol: (symbol: string) => Promise<Market | null>;
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
    // Session open assumed mid-week so the settlement refuse is what we prove.
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

describe('D26-P1-T7 public doors — complete refuse-closed forex product', () => {
  it('GET forex.settlementStatus is refuse-closed and names socket + P0-05 blockers', async () => {
    const app = await mountTrpc();
    const { statusCode, body } = await getTrpc(app, 'forex.settlementStatus');
    expect(statusCode).toBe(200);
    const payload = (body.result?.data ?? body.result) as {
      published?: boolean;
      socket?: string;
      blockers?: string[];
      residual?: string;
      allowed?: { productionActiveListing?: boolean; productionPlace?: boolean; paperListing?: boolean };
    };
    expect(payload.published).toBe(false);
    expect(payload.socket).toBe(FOREX_SETTLEMENT_SOCKET);
    expect(payload.blockers).toEqual(['settlement_asset_law', 'fiat_settle_rails']);
    expect(payload.residual).toMatch(/settlement asset/i);
    expect(payload.allowed?.productionActiveListing).toBe(false);
    expect(payload.allowed?.productionPlace).toBe(false);
    expect(payload.allowed?.paperListing).toBe(true);
    await app.close();
  });

  it('POST forex.assertProductionListing refuses production FX on the wire (names socket)', async () => {
    const app = await mountTrpc();
    const { statusCode, body } = await postTrpc(app, 'forex.assertProductionListing', {
      assetClass: 'forex',
      status: 'active',
      paper: false,
    });
    expect(statusCode).toBe(400);
    expect(body.error!.message).toMatch(/settlement asset/);
    await app.close();
  });

  it('POST forex.assertProductionListing allows paper + crypto (honest residual)', async () => {
    const app = await mountTrpc();
    const paper = await postTrpc(app, 'forex.assertProductionListing', {
      assetClass: 'forex',
      status: 'active',
      paper: true,
    });
    expect(paper.statusCode).toBe(200);
    const crypto = await postTrpc(app, 'forex.assertProductionListing', {
      assetClass: 'crypto',
      status: 'active',
      paper: false,
    });
    expect(crypto.statusCode).toBe(200);
    // Gate identity with the service helper — same function listMarket uses.
    expect(() => assertProductionUnsettledAssetClassListing({ assetClass: 'forex', status: 'pending', paper: false })).not.toThrow();
    await app.close();
  });

  it('POST /api/v1/orders: production forex → trade.unsettled_asset_class_listing via real rails', async () => {
    const eurusd = fakeMarket({
      id: '00000000-0000-4000-8000-000000000002',
      symbol: 'EUR/USD',
      baseAsset: 'EUR',
      quoteAsset: 'USD',
      schedule: 'fx-global',
      assetClass: 'forex',
      paper: false,
      tickSize: parseAmount('0.00001'),
      lotSize: parseAmount('1000'),
      minQty: parseAmount('1000'),
    });
    const marketBySymbol = async (s: string) => (s === eurusd.symbol ? eurusd : null);
    const fundHold = vi.fn();
    const placeOrder = vi.fn(realSettlementPlaceOrder({ marketBySymbol, fundHold }));

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
        clientOrderId: 't7-forex-place-1',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BadRequest');
    expect(res.json().intafacedCode).toBe(FOREX_SETTLEMENT_REFUSE_CODE);
    expect(String(res.json().message)).toContain('settlement asset');
    expect(placeOrder).toHaveBeenCalled();
    expect(fundHold).not.toHaveBeenCalled();
    await app.close();
  });

  it('POST /api/v1/orders: crypto production place clears settlement rails', async () => {
    const btc = fakeMarket({
      id: '00000000-0000-4000-8000-000000000001',
      symbol: 'BTC/USDT',
      schedule: 'crypto-24x7',
      assetClass: 'crypto',
      paper: false,
    });
    const marketBySymbol = async (s: string) => (s === btc.symbol ? btc : null);
    const fundHold = vi.fn();
    const placeOrder = vi.fn(realSettlementPlaceOrder({ marketBySymbol, fundHold }));

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
        clientOrderId: 't7-crypto-place-1',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(placeOrder).toHaveBeenCalled();
    expect(fundHold).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
