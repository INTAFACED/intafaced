import { TradeService, CopyService } from './controls/test-admission.js';
/**
 * Unit card (D26-P2-01a):
 * Promise: futures + convert + copy + algo refuse invent through mounted
 *   Fastify public doors (edge-signed tRPC + public/private REST) — not
 *   service-unit-only guards behind createCaller alone.
 * Break: funding-rate could invent `"0"` when unpublished; convert.quote could
 *   invent a mid on an empty book; copy.follow / settleFeeShare could invent
 *   §8 jurisdiction / leader_share_bps; algo.createTwap could invent a mark
 *   feed; private POST /orders could invent futures access when the kill-switch
 *   is off.
 * Done bar:
 *   · GET /api/v1/funding-rate/:symbol on futures with null published rate →
 *     NotSupported / trade.funding_rate_unavailable; wire carries no fundingRate.
 *   · convert.quote / convert.execute over /trpc refuse convert_insufficient_depth
 *     and convert_disabled by code (no invented avg).
 *   · copy.follow / copy.settleFeeShare refuse blank §8 (jurisdiction / fee-share)
 *     as PRECONDITION_FAILED; deskStatus exposes unpublished.
 *   · algo.createTwap refuses algo_mark_missing / algo_disabled over the wire.
 *   · POST /api/v1/orders with futures_disabled → NotSupported (keep symbol).
 * Class: N (honesty) / M surface (no invent mids/rates/§8). Leverage:
 *   createTradeRouter + registerPublicRest + registerPrivateRest + CopyService
 *   (Phase A shell doors — wire honesty, do not rebuild trade).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryLedger } from '@intafaced/ledger-client';
import { createTradeRouter } from './router.js';
import { registerPublicRest, fakeMarket } from './public-rest.js';
import { registerPrivateRest, type PrivateRestDeps } from './private-rest.js';
import { TradeError } from './spot/types.js';

import { MemoryCopyFollowStore } from './copy/follow-store.js';
import type { CopyFeeShareLaw, CopyJurisdictionLaw } from './copy/fee-share-law.js';
import { COPY_FEE_SHARE_RESIDUAL, COPY_JURISDICTION_RESIDUAL } from './copy/errors.js';

const EDGE_SECRET = 'trade-promise-falsify-public-doors-edge-secret-32';
const USER = '11111111-1111-4111-8111-111111111111';
const LEADER = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';

const here = dirname(fileURLToPath(import.meta.url));
const edgeContext = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-trade' });

const publishedFee: CopyFeeShareLaw = {
  published: true,
  leaderShareBps: 5_000,
  earningsCapPerFollower: '100',
  decayRoundTrips: 100,
  decayShareBps: 1_000,
};

const publishedJur: CopyJurisdictionLaw = {
  published: true,
  allowedRegions: ['DE'],
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

function signedHeaders(p: Principal = principal(), region = 'DE'): Record<string, string> {
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, region),
    'x-intafaced-region': region,
  };
}

type WireBody = {
  result?: { data?: unknown };
  error?: { message?: string; data?: { code?: string; httpStatus?: number } };
};

function stubTrade(overrides: Partial<TradeService> = {}): TradeService {
  return {
    convertQuote: async () => {
      throw new Error('convertQuote not stubbed');
    },
    convertExecute: async () => {
      throw new Error('convertExecute not stubbed');
    },
    createTwap: async () => {
      throw new Error('createTwap not stubbed');
    },
    getAlgo: async () => {
      throw new Error('getAlgo not stubbed');
    },
    algoProgress: async () => {
      throw new Error('algoProgress not stubbed');
    },
    pauseAlgo: async () => {
      throw new Error('pauseAlgo not stubbed');
    },
    resumeAlgo: async () => {
      throw new Error('resumeAlgo not stubbed');
    },
    cancelAlgo: async () => {
      throw new Error('cancelAlgo not stubbed');
    },
    ...overrides,
  } as unknown as TradeService;
}

async function mountTrpc(opts?: {
  trade?: Partial<TradeService>;
  copy?: CopyService | null;
}): Promise<{ app: ReturnType<typeof Fastify>; trade: TradeService; copy: CopyService | null }> {
  const trade = stubTrade(opts?.trade);
  const copy =
    opts?.copy === null
      ? null
      : (opts?.copy ??
        new CopyService(new MemoryLedger(), {
          feeShareLaw: { published: false },
          jurisdictionLaw: { published: false },
        }));

  const router = createTradeRouter(trade, undefined, copy ?? undefined);
  const app = Fastify({ logger: false });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router,
      createContext: ({ req }) => edgeContext({ headers: req.headers, id: req.id }),
    } satisfies FastifyTRPCPluginOptions<typeof router>['trpcOptions'],
  });
  await app.ready();
  return { app, trade, copy };
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

/** Queries are GET-only on the Fastify tRPC adapter (POST → 405). */
async function getTrpc(
  app: ReturnType<typeof Fastify>,
  path: string,
  input: Record<string, unknown> = {},
  headers: Record<string, string> = signedHeaders(),
): Promise<{ statusCode: number; body: WireBody }> {
  const qs = `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.inject({
    method: 'GET',
    url: `/trpc/${path}${qs}`,
    headers,
  });
  return { statusCode: res.statusCode, body: res.json() as WireBody };
}

function privateDeps(overrides: Partial<PrivateRestDeps> = {}): PrivateRestDeps {
  return {
    edgeSecret: EDGE_SECRET,
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

// ═══════════════════════════════════════════════════════════════════════════════
// Refuse-closed pins — codes / residuals that invent would erase.
// ═══════════════════════════════════════════════════════════════════════════════

describe('D26-P2-01a refuse-closed defaults (no invent)', () => {
  it('copy residuals name DIRECTION §8 — never invent rates or geo allowlist', () => {
    expect(COPY_FEE_SHARE_RESIDUAL).toMatch(/never invent fee-share rates/i);
    expect(COPY_JURISDICTION_RESIDUAL).toMatch(/never invent geo allowlist/i);
  });

  it('public funding-rate door documents never-invent-zero for unpublished futures', () => {
    const src = readFileSync(join(here, 'public-rest.ts'), 'utf8');
    expect(src).toMatch(/Never invent "0"/);
    expect(src).toMatch(/trade\.funding_rate_unavailable/);
  });

  it('TWAP create refuses blank two-sided mark rather than inventing a feed', () => {
    const src = readFileSync(join(here, 'spot/trade-service.ts'), 'utf8');
    expect(src).toMatch(/refusing algo rather than inventing a feed/);
    expect(src).toMatch(/trade\.algo_mark_missing/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Futures — public + private REST doors
// ═══════════════════════════════════════════════════════════════════════════════

describe('D26-P2-01a public doors — futures refuse invent rates / access', () => {
  it('GET /api/v1/funding-rate refuses unpublished futures rate (never invents 0)', async () => {
    const perp = fakeMarket({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      symbol: 'BTC/USDT-PERP',
      kind: 'futures',
    });
    const app = Fastify({ logger: false });
    registerPublicRest(app, {
      markets: async () => [perp],
      marketBySymbol: async (s) => (s === perp.symbol ? perp : null),
      depth: async () => ({ bids: [], asks: [], sequence: 0 }),
      publicTape: async () => [],
      candles: async () => [],
      fundingRateForMarket: async () => null,
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/v1/funding-rate/BTC%2FUSDT-PERP' });
    expect(res.statusCode).toBe(501);
    expect(res.json().code).toBe('NotSupported');
    expect(res.json().intafacedCode).toBe('trade.funding_rate_unavailable');
    expect(JSON.stringify(res.json())).not.toMatch(/"fundingRate"/);
    await app.close();
  });

  it('GET /api/v1/funding-rate refuses spot with typed code — no fabricated rate', async () => {
    const spot = fakeMarket({ symbol: 'BTC/USDT', kind: 'spot' });
    const app = Fastify({ logger: false });
    registerPublicRest(app, {
      markets: async () => [spot],
      marketBySymbol: async (s) => (s === spot.symbol ? spot : null),
      depth: async () => ({ bids: [], asks: [], sequence: 0 }),
      publicTape: async () => [],
      candles: async () => [],
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/v1/funding-rate/BTC%2FUSDT' });
    expect(res.statusCode).toBe(501);
    expect(res.json().intafacedCode).toBe('trade.funding_rate_spot_market');
    expect(JSON.stringify(res.json())).not.toMatch(/"fundingRate"/);
    await app.close();
  });

  it('POST /api/v1/orders maps futures_disabled to NotSupported (no invent access)', async () => {
    const placeOrder = vi.fn(async () => {
      throw new TradeError('BTC/USDT-PERP: futures orders are disabled (TRADE_FUTURES_ENABLED=false)', 'trade.futures_disabled');
    });
    const app = Fastify({ logger: false });
    registerPrivateRest(
      app,
      privateDeps({
        placeOrder,
        marketBySymbol: async (s) => (s === 'BTC/USDT-PERP' ? fakeMarket({ symbol: 'BTC/USDT-PERP', kind: 'futures' }) : null),
      }),
    );
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { 'content-type': 'application/json', ...signedHeaders() },
      payload: {
        symbol: 'BTC/USDT-PERP',
        type: 'limit',
        side: 'buy',
        amount: '0.01',
        price: '50000',
        clientOrderId: 'pf-futures-disabled-1',
      },
    });

    // NotSupported + 403: symbol stays listed; method is refused (keep, don't drop).
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('NotSupported');
    expect(res.json().intafacedCode).toBe('trade.futures_disabled');
    expect(placeOrder).toHaveBeenCalled();
    await app.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Convert — tRPC doors
// ═══════════════════════════════════════════════════════════════════════════════

describe('D26-P2-01a public doors — convert refuse invent mids / depth', () => {
  it('convert.quote refuses insufficient depth over the wire (no invent avg)', async () => {
    const convertQuote = vi.fn(async () => {
      throw new TradeError('insufficient book depth to convert 1 BTC — only 0 available', 'trade.convert_insufficient_depth');
    });
    const { app } = await mountTrpc({ trade: { convertQuote } });

    const { statusCode, body } = await getTrpc(app, 'convert.quote', {
      symbol: 'BTC/USDT',
      side: 'buy',
      qty: '1',
    });

    expect(statusCode).toBe(400);
    expect(body.error!.message).toMatch(/trade\.convert_insufficient_depth|insufficient book depth/i);
    expect(convertQuote).toHaveBeenCalled();
    await app.close();
  });

  it('convert.execute refuses kill-switch over the wire (no invent convert path)', async () => {
    const convertExecute = vi.fn(async () => {
      throw new TradeError('convert is disabled by the operator kill-switch', 'trade.convert_disabled');
    });
    const { app } = await mountTrpc({ trade: { convertExecute } });

    const { statusCode, body } = await postTrpc(app, 'convert.execute', {
      quoteId: '00000000-0000-4000-8000-0000000000c1',
      symbol: 'BTC/USDT',
      side: 'buy',
      qty: '1',
      clientConvertId: 'pf-convert-off-1',
    });

    expect(statusCode).toBe(400);
    expect(body.error!.message).toMatch(/trade\.convert_disabled|convert is disabled/i);
    expect(convertExecute).toHaveBeenCalled();
    await app.close();
  });

  it('anonymous convert.quote never reaches the service', async () => {
    const convertQuote = vi.fn(async () => {
      throw new TradeError('should not run', 'trade.convert_insufficient_depth');
    });
    const { app } = await mountTrpc({ trade: { convertQuote } });

    const { statusCode } = await getTrpc(
      app,
      'convert.quote',
      { symbol: 'BTC/USDT', side: 'buy', qty: '1' },
      { 'x-intafaced-region': 'DE' },
    );

    expect(statusCode).toBe(401);
    expect(convertQuote).not.toHaveBeenCalled();
    await app.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Copy — tRPC doors (real CopyService, blank §8)
// ═══════════════════════════════════════════════════════════════════════════════

describe('D26-P2-01a public doors — copy refuse invent §8 rates / jurisdiction', () => {
  it('copy.deskStatus is refuse-closed when §8 laws are blank', async () => {
    const { app } = await mountTrpc();

    const { statusCode, body } = await getTrpc(app, 'copy.deskStatus');
    expect(statusCode).toBe(200);
    const payload = (body.result?.data ?? body.result) as {
      feeSharePublished?: boolean;
      jurisdictionPublished?: boolean;
      residual?: string;
    };
    expect(payload.feeSharePublished).toBe(false);
    expect(payload.jurisdictionPublished).toBe(false);
    expect(payload.residual).toMatch(/DIRECTION §8/);
    await app.close();
  });

  it('copy.follow refuses blank jurisdiction — never invents allowlist', async () => {
    const copy = new CopyService(new MemoryLedger(), {
      feeShareLaw: publishedFee,
      jurisdictionLaw: { published: false },
    });
    const { app } = await mountTrpc({ copy });

    const { statusCode, body } = await postTrpc(app, 'copy.follow', {
      leaderId: LEADER,
      region: 'DE',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '100',
      maxAggregateExposure: '1000',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });

    expect(statusCode).toBe(412);
    expect(body.error!.message).toMatch(/jurisdiction|DIRECTION §8|trade\.copy_jurisdiction_blank/i);
    await app.close();
  });

  it('copy.closeFollowsInClosedRegions detaches follows in every closed region over HTTP', async () => {
    const store = new MemoryCopyFollowStore();
    const open = new CopyService(new MemoryLedger(), {
      feeShareLaw: publishedFee,
      jurisdictionLaw: publishedJur,
      store,
    });
    await open.follow(principal(), {
      leaderId: LEADER,
      region: 'DE',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '100',
      maxAggregateExposure: '1000',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    const closed = new CopyService(new MemoryLedger(), {
      feeShareLaw: publishedFee,
      jurisdictionLaw: { published: true, allowedRegions: [] },
      store,
    });
    const { app } = await mountTrpc({ copy: closed });

    const { statusCode, body } = await postTrpc(app, 'copy.closeFollowsInClosedRegions', {});
    expect(statusCode).toBe(200);
    const payload = (body.result?.data ?? body.result) as {
      scanned?: number;
      closed?: number;
      stillOpen?: number;
      flattenInvented?: boolean;
    };
    expect(payload).toMatchObject({ scanned: 1, closed: 1, stillOpen: 0, flattenInvented: false });
    expect((await closed.listMyFollows(principal(), 50))[0]?.relationshipState).toBe('DETACHED');
    await app.close();
  });

  it('copy.settleFeeShare refuses blank §8 fee rates — never invents leader_share_bps', async () => {
    const copy = new CopyService(new MemoryLedger(), {
      feeShareLaw: { published: false },
      jurisdictionLaw: publishedJur,
    });
    const follow = await copy.follow(principal(), {
      leaderId: LEADER,
      region: 'DE',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '100',
      maxAggregateExposure: '1000',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    const { app } = await mountTrpc({ copy });

    const { statusCode, body } = await postTrpc(app, 'copy.settleFeeShare', {
      followId: follow.followId,
      fillId: 'fill-blank-rate',
      assetId: 'USDT',
      followerFillNotional: '1000',
      protocolFeeBps: 10,
    });

    expect(statusCode).toBe(412);
    expect(body.error!.message).toMatch(/fee-share|leader_share|trade\.copy_fee_share_blank|DIRECTION §8/i);
    await app.close();
  });
});

describe('D30 public doors — copy.placeMirror refuse-closed on mounted tRPC', () => {
  it('copy.placeMirror refuses trade.copy_place_disabled when copy service is unwired', async () => {
    const { app } = await mountTrpc({ copy: null });

    const { statusCode, body } = await postTrpc(app, 'copy.placeMirror', {
      followId: 'aaaa1111-1111-4111-8111-111111111111',
      fillId: 'leader-fill-door-1',
      leaderPaper: false,
    });

    expect(statusCode).toBe(412);
    expect(body.error!.message).toMatch(/trade\.copy_place_disabled|TRADE_COPY_PLACE_MIRROR/i);
    await app.close();
  });

  it('copy.placeMirror refuses when TRADE_COPY_PLACE_MIRROR is off even if the port is wired', async () => {
    const copy = new CopyService(new MemoryLedger(), {
      feeShareLaw: publishedFee,
      jurisdictionLaw: publishedJur,
      placeMirrorEnabled: false,
      placeFollowerOrder: async () => ({ orderId: 'should-not-run' }),
    });
    const { app } = await mountTrpc({ copy });

    const { statusCode, body } = await postTrpc(app, 'copy.placeMirror', {
      followId: 'bbbb2222-2222-4222-8222-222222222222',
      fillId: 'leader-fill-door-2',
      leaderPaper: false,
    });

    expect(statusCode).toBe(412);
    expect(body.error!.message).toMatch(/trade\.copy_place_disabled|TRADE_COPY_PLACE_MIRROR/i);
    await app.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Algo — tRPC doors
// ═══════════════════════════════════════════════════════════════════════════════

describe('D26-P2-01a public doors — algo refuse invent mark feed', () => {
  it('algo.createTwap refuses missing two-sided mark over the wire', async () => {
    const createTwap = vi.fn(async () => {
      throw new TradeError(
        'BTC/USDT: no two-sided mark at creation — refusing algo rather than inventing a feed',
        'trade.algo_mark_missing',
      );
    });
    const { app } = await mountTrpc({ trade: { createTwap } });

    const { statusCode, body } = await postTrpc(app, 'algo.createTwap', {
      symbol: 'BTC/USDT',
      side: 'buy',
      totalQty: '1',
      durationMs: 60_000,
      sliceIntervalMs: 10_000,
      clientAlgoId: 'pf-algo-mark-1',
    });

    expect(statusCode).toBe(400);
    expect(body.error!.message).toMatch(/trade\.algo_mark_missing|inventing a feed/i);
    expect(createTwap).toHaveBeenCalled();
    await app.close();
  });

  it('algo.createTwap refuses kill-switch over the wire (no invent schedule)', async () => {
    const createTwap = vi.fn(async () => {
      throw new TradeError('algo execution is disabled by the operator kill-switch', 'trade.algo_disabled');
    });
    const { app } = await mountTrpc({ trade: { createTwap } });

    const { statusCode, body } = await postTrpc(app, 'algo.createTwap', {
      symbol: 'BTC/USDT',
      side: 'buy',
      totalQty: '1',
      durationMs: 60_000,
      sliceIntervalMs: 10_000,
      clientAlgoId: 'pf-algo-off-1',
    });

    expect(statusCode).toBe(400);
    expect(body.error!.message).toMatch(/trade\.algo_disabled|algo execution is disabled/i);
    expect(createTwap).toHaveBeenCalled();
    await app.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Spine reprove — malformed / unset wire shapes (mounted doors only)
// ═══════════════════════════════════════════════════════════════════════════════

describe('D26-P2-01a spine reprove — malformed / unset over mounted doors', () => {
  it('GET /api/v1/funding-rate for unknown symbol is badSymbol — never invents a rate', async () => {
    const app = Fastify({ logger: false });
    registerPublicRest(app, {
      markets: async () => [],
      marketBySymbol: async () => null,
      depth: async () => ({ bids: [], asks: [], sequence: 0 }),
      publicTape: async () => [],
      candles: async () => [],
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/v1/funding-rate/NOPE%2FUSDT-PERP' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('BadSymbol');
    expect(JSON.stringify(res.json())).not.toMatch(/"fundingRate"/);
    await app.close();
  });

  it('convert.quote rejects sub-min symbol at the schema — service never runs', async () => {
    const convertQuote = vi.fn();
    const { app } = await mountTrpc({ trade: { convertQuote } });

    const { statusCode } = await getTrpc(app, 'convert.quote', { symbol: 'B', side: 'buy', qty: '1' });
    expect(statusCode).toBe(400);
    expect(convertQuote).not.toHaveBeenCalled();
    await app.close();
  });

  it('convert.execute rejects missing quoteId at the schema — never invents a mid', async () => {
    const convertExecute = vi.fn();
    const { app } = await mountTrpc({ trade: { convertExecute } });

    const { statusCode } = await postTrpc(app, 'convert.execute', {
      symbol: 'BTC/USDT',
      side: 'buy',
      qty: '1',
      clientConvertId: 'no-quote',
    });

    expect(statusCode).toBe(400);
    expect(convertExecute).not.toHaveBeenCalled();
    await app.close();
  });

  it('algo.createTwap rejects duration below schema minimum — no invent schedule', async () => {
    const createTwap = vi.fn();
    const { app } = await mountTrpc({ trade: { createTwap } });

    const { statusCode } = await postTrpc(app, 'algo.createTwap', {
      symbol: 'BTC/USDT',
      side: 'buy',
      totalQty: '1',
      durationMs: 500,
      sliceIntervalMs: 10_000,
      clientAlgoId: 'pf-algo-duration-floor',
    });

    expect(statusCode).toBe(400);
    expect(createTwap).not.toHaveBeenCalled();
    await app.close();
  });

  it('copy.follow rejects empty permittedMarkets over the wire — never invents a desk', async () => {
    const copy = new CopyService(new MemoryLedger(), {
      feeShareLaw: publishedFee,
      jurisdictionLaw: publishedJur,
    });
    const { app } = await mountTrpc({ copy });

    const { statusCode, body } = await postTrpc(app, 'copy.follow', {
      leaderId: LEADER,
      region: 'DE',
      permittedMarkets: [],
      maxNotionalPerOrder: '100',
      maxAggregateExposure: '1000',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });

    expect(statusCode).toBe(400);
    expect(body.error!.message).toMatch(/permittedMarkets|at least one/i);
    await app.close();
  });

  it('POST /api/v1/orders without principal never reaches placeOrder', async () => {
    const placeOrder = vi.fn();
    const app = Fastify({ logger: false });
    registerPrivateRest(
      app,
      privateDeps({
        placeOrder,
        marketBySymbol: async (s) => (s === 'BTC/USDT' ? fakeMarket({ symbol: 'BTC/USDT', kind: 'spot' }) : null),
      }),
    );
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { 'content-type': 'application/json' },
      payload: {
        symbol: 'BTC/USDT',
        type: 'limit',
        side: 'buy',
        amount: '0.01',
        price: '50000',
        clientOrderId: 'pf-unauth-order-1',
      },
    });

    expect(res.statusCode).toBe(401);
    expect(placeOrder).not.toHaveBeenCalled();
    await app.close();
  });
});
