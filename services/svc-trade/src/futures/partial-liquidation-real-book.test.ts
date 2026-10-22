/**
 * D26-P1-T1c / DIRECTION §1 MVP item 3 — Partial liquidation vs real book.
 *
 * Done bar: min close restores maintenance; ledger recipe only (no invent balances).
 *
 * What this proves that the planner property suite and the gap-series file do not:
 *   · Depth is an EngineDepth (bids/asks levels), read through the SAME adapter
 *     production wires (`depthNotionalSourceFromDepth` → `sideDepthNotional`).
 *     A constant `depthNotional()` stub cannot catch a regression that rates
 *     positions against invented depth while the matching book is empty.
 *   · The tick posts only existing ledger-client recipes (`futures.loss.realized`)
 *     — no second money book, no invented insurance balance.
 *   · After an uncapped partial, the reduced row clears the liquidation threshold
 *     (maintenance restored), and GET /api/v1/positions shows the smaller size.
 *
 * What it deliberately does not invent: ladder tier numbers (WIDE_POLICY is a test
 * harness so an uncapped restore is reachable — same reason as maintenance-ladder
 * tests), grace duration (D3), or insurance fund size.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { Position } from '@intafaced/exchange-contract';
import { formatAmount, parseAmount as amt, type AccountRef, type Amount, type Balance, type PostRequest } from '@intafaced/ledger-client';
import { registerPrivateRest, type PrivateRestDeps } from '../private-rest.js';
import type { EngineDepth } from '../spot/matching-client.js';
import { memoryAcceptedMarkStore } from './accepted-mark.js';
import { depthNotionalSourceFromDepth, sideDepthNotional } from './mark-from-depth.js';
import { planLadderRung, type FuturesLadderPolicy } from './maintenance-ladder.js';
import {
  memoryLiquidationAttemptStore,
  runLiquidationTick,
  type LiquidationPositionRow,
  type PositionReducer,
  type QuotedMarkSource,
} from './liquidation-tick.js';

const SECRET = 'a-trade-partial-liq-real-book-edge-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const POSITION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AT = new Date('2026-08-12T14:00:00.000Z');

/**
 * Widened band so an uncapped partial is reachable — see maintenance-ladder.test.ts.
 * Test harness only. Live jobs omit ladderPolicy (skipped_d3_unset). These bps
 * are not product law and must not be copied into index.ts / startFuturesJobs.
 */
const WIDE_POLICY: FuturesLadderPolicy = {
  tiers: [
    { uptoDepthBps: 500, maintenanceBps: 500 },
    { uptoDepthBps: 5_000, maintenanceBps: 800 },
    { uptoDepthBps: Number.MAX_SAFE_INTEGER, maintenanceBps: 1_500 },
  ],
  marginCallBps: 12_000,
  targetBps: 15_000,
  maxTrancheBps: 10_000,
};

/** Matching-shaped book: enough bid notional that a long rates into the cheap tier. */
function deepMatchingBook(): EngineDepth {
  return {
    // Long closes into bids: 93×10_000 + 92×2_000 ≈ 1.114e6 quote notional.
    bids: [
      ['93', '10000'],
      ['92', '2000'],
    ],
    asks: [['94', '10000']],
    sequence: 7,
  };
}

/** Same prices, thin bids — position notional is a large fraction of close-into depth. */
function thinMatchingBook(): EngineDepth {
  return {
    bids: [
      ['93', '50'],
      ['92', '50'],
    ],
    asks: [['94', '10000']],
    sequence: 8,
  };
}

function underwaterLong(): LiquidationPositionRow {
  return {
    positionId: POSITION_ID,
    userId: USER,
    side: 'long',
    size: amt('10'),
    entryPrice: amt('100'),
    margin: amt('100'),
    marginAsset: 'USDT',
    marketId: 'm1',
    symbol: 'BTC/USDT-PERP',
  };
}

function liveRow(seed: LiquidationPositionRow) {
  const row: LiquidationPositionRow = { ...seed };
  let closed: { reason: string } | null = null;

  const reducer: PositionReducer = {
    async reduce(positionId, input) {
      expect(positionId).toBe(row.positionId);
      expect(input.sizeClosed).toBeGreaterThan(0n);
      expect(input.sizeClosed).toBeLessThan(row.size);
      row.size -= input.sizeClosed;
      row.margin = input.marginRemaining;
    },
  };

  return {
    row,
    reducer,
    closer: {
      async markLiquidated(_id: string, meta: { liquidationId: string; reason: string }) {
        closed = { reason: meta.reason };
        row.size = 0n;
      },
    },
    positions: {
      async listOpen() {
        return closed || row.size <= 0n ? [] : [row];
      },
    },
    get closed() {
      return closed;
    },
  };
}

function recordingLedger(opts?: { insuranceAvailable?: Amount }) {
  const posts: PostRequest[] = [];
  const insuranceAvailable = opts?.insuranceAvailable ?? amt('1000000');
  return {
    posts,
    ledger: {
      async post(req: PostRequest) {
        posts.push(req);
        return { id: `tx-${posts.length}`, idempotencyKey: req.idempotencyKey } as never;
      },
      async balance(ref: AccountRef): Promise<Balance> {
        // A position's collateral pot: ample, so the tick plans against the row's own margin (the ledger-pot
        // divergence guard takes min(row, pot)). The guard itself is proven in liquidation-rung-machine.test.ts ("divergence guard: the plan is taken against min(row margin, ledger pot)").
        const amount =
          ref.ownerType === 'house' && ref.ownerId === 'insurance-fund'
            ? insuranceAvailable
            : ref.kind === 'collateral'
              ? amt('1000000')
              : 0n;
        return { account: ref, accountId: `${ref.ownerType}:${ref.ownerId}`, amount };
      },
    },
  };
}

function quotedAt(price: string): QuotedMarkSource {
  return {
    async markPrice() {
      return price;
    },
    async quote({ marketId, symbol, at }) {
      return { marketId, symbol, price: amt(price), asOf: at, quality: 'mid' };
    },
  };
}

function assertBalanced(req: PostRequest): void {
  let credits = 0n;
  let debits = 0n;
  for (const entry of req.entries) {
    if (entry.direction === 'credit') credits += entry.amount;
    else debits += entry.amount;
  }
  expect(formatAmount(credits)).toBe(formatAmount(debits));
}

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '33333333-3333-4333-8333-333333333333',
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
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

function wirePosition(row: LiquidationPositionRow): Position {
  const size = formatAmount(row.size);
  const entry = formatAmount(row.entryPrice);
  const margin = formatAmount(row.margin);
  return {
    id: row.positionId,
    symbol: row.symbol ?? 'BTC/USDT-PERP',
    timestamp: AT.getTime(),
    datetime: AT.toISOString(),
    side: row.side,
    status: 'open',
    closingReason: null,
    contracts: size,
    contractSize: null,
    entryPrice: entry,
    markPrice: null,
    notional: formatAmount((row.size * row.entryPrice) / 10n ** 18n),
    leverage: '10',
    collateral: margin,
    initialMargin: margin,
    maintenanceMargin: null,
    unrealizedPnl: null,
    realizedPnl: null,
    liquidationPrice: null,
    marginMode: 'isolated',
    percentage: null,
  };
}

function baseDeps(overrides: Partial<PrivateRestDeps> = {}): PrivateRestDeps {
  return {
    edgeSecret: SECRET,
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

describe('D26-P1-T1c — partial liquidation vs real matching book', () => {
  it('rates close-into depth from EngineDepth levels (same adapter as futures-jobs)', async () => {
    const book = deepMatchingBook();
    const fromLevels = sideDepthNotional(book, 'long');
    expect(fromLevels).not.toBeNull();
    expect(formatAmount(fromLevels!)).toBe('1114000');

    const source = depthNotionalSourceFromDepth(async () => book);
    const viaPort = await source.depthNotional({ marketId: 'm1', side: 'long' });
    expect(viaPort).toBe(fromLevels);
  });

  it('tick: min close against real book restores maintenance; ledger recipe only', async () => {
    const live = liveRow(underwaterLong());
    const sizeBefore = live.row.size;
    const { ledger, posts } = recordingLedger();
    const book = deepMatchingBook();
    const depth = depthNotionalSourceFromDepth(async (marketId) => {
      expect(marketId).toBe('m1');
      return book;
    });

    const result = await runLiquidationTick({
      marks: quotedAt('93'),
      positions: live.positions,
      closer: live.closer,
      attempts: memoryLiquidationAttemptStore(),
      acceptedMarks: memoryAcceptedMarkStore(),
      ledger,
      now: () => AT,
      ladder: { depth, reducer: live.reducer, policy: WIDE_POLICY },
    });

    expect(result.partial).toBe(1);
    expect(result.liquidated).toBe(0);
    expect(result.items[0]!.outcome).toBe('partially_liquidated');
    expect(result.items[0]!.reason).toBe('ladder_partial');
    expect(live.closed).toBeNull();
    expect(live.row.size).toBeLessThan(sizeBefore);
    expect(live.row.size).toBeGreaterThan(0n);

    // Maintenance restored: remaining row is not liquidatable at the same mark/book.
    const depthNotional = (await depth.depthNotional({ marketId: 'm1', side: 'long' }))!;
    const after = planLadderRung({
      position: {
        positionId: live.row.positionId,
        userId: live.row.userId,
        side: live.row.side,
        size: live.row.size,
        entryPrice: live.row.entryPrice,
        margin: live.row.margin,
        marginAsset: live.row.marginAsset,
      },
      markPrice: amt('93'),
      depthNotional,
      policy: WIDE_POLICY,
    });
    expect(after.healthBps).toBeGreaterThanOrEqual(10_000);
    expect(after.action).not.toBe('liquidate');

    // Ledger recipe only — existing futuresRealizeLoss; balanced; no invent balances.
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) {
      assertBalanced(post);
      expect(post.reason).toBe('futures.loss.realized');
      expect(post.idempotencyKey.startsWith('futures.loss:')).toBe(true);
    }
    expect(posts.every((p) => p.reason === 'futures.loss.realized')).toBe(true);
    expect(posts.filter((p) => p.reason === 'futures.margin.release')).toHaveLength(0);
    const meta = posts[0]!.meta as { fromMargin?: string; fromInsurance?: string };
    expect(BigInt(meta.fromInsurance ?? '0')).toBe(0n);
    expect(BigInt(meta.fromMargin ?? '0')).toBeGreaterThan(0n);
  });

  it('empty matching book → skipped_no_depth (never invents depth to seize)', async () => {
    const live = liveRow(underwaterLong());
    const { ledger, posts } = recordingLedger();
    const depth = depthNotionalSourceFromDepth(async () => ({ bids: [], asks: [], sequence: 1 }));

    const result = await runLiquidationTick({
      marks: quotedAt('93'),
      positions: live.positions,
      closer: {
        async markLiquidated() {
          throw new Error('must not close without book depth');
        },
      },
      attempts: memoryLiquidationAttemptStore(),
      acceptedMarks: memoryAcceptedMarkStore(),
      ledger,
      now: () => AT,
      ladder: {
        depth,
        reducer: {
          async reduce() {
            throw new Error('must not reduce without book depth');
          },
        },
        policy: WIDE_POLICY,
      },
    });

    expect(result.items[0]!.outcome).toBe('skipped_no_depth');
    expect(posts).toHaveLength(0);
    expect(live.row.size).toBe(amt('10'));
  });

  it('thin vs deep EngineDepth changes the maintenance requirement — depth is not a constant', () => {
    const mark = amt('93');
    const position = underwaterLong();
    const deep = sideDepthNotional(deepMatchingBook(), 'long')!;
    const thin = sideDepthNotional(thinMatchingBook(), 'long')!;
    expect(thin).toBeLessThan(deep);

    const deepRung = planLadderRung({ position, markPrice: mark, depthNotional: deep, policy: WIDE_POLICY });
    const thinRung = planLadderRung({ position, markPrice: mark, depthNotional: thin, policy: WIDE_POLICY });
    expect(deepRung.action).toBe('liquidate');
    expect(thinRung.action).toBe('liquidate');

    // Thin book → higher depth-ratio tier → stricter maintenance. Same mark and
    // size with different EngineDepth must not produce identical requirements —
    // that would mean the ladder ignored the book.
    expect(thinRung.maintenanceBps).toBeGreaterThan(deepRung.maintenanceBps);
    expect(thinRung.maintenanceRequired).toBeGreaterThan(deepRung.maintenanceRequired);
  });
});

describe('D26-P1-T1c public door — reduced size observable on GET /positions', () => {
  it('tick partial → GET /api/v1/positions returns the smaller contracts', async () => {
    const live = liveRow(underwaterLong());
    const sizeBefore = formatAmount(live.row.size);
    const { ledger } = recordingLedger();
    const depth = depthNotionalSourceFromDepth(async () => deepMatchingBook());

    const tick = await runLiquidationTick({
      marks: quotedAt('93'),
      positions: live.positions,
      closer: live.closer,
      attempts: memoryLiquidationAttemptStore(),
      acceptedMarks: memoryAcceptedMarkStore(),
      ledger,
      now: () => AT,
      ladder: { depth, reducer: live.reducer, policy: WIDE_POLICY },
    });
    expect(tick.items[0]!.outcome).toBe('partially_liquidated');

    const sizeAfter = formatAmount(live.row.size);
    expect(sizeAfter).not.toBe(sizeBefore);

    const app = Fastify();
    registerPrivateRest(
      app,
      baseDeps({
        listPositions: async (p) => {
          if (p.userId !== USER) return [];
          return live.row.size > 0n ? [wirePosition(live.row)] : [];
        },
      }),
    );
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/positions',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Position[];
    expect(body).toHaveLength(1);
    expect(body[0]!.id).toBe(POSITION_ID);
    expect(body[0]!.contracts).toBe(sizeAfter);
    expect(body[0]!.contracts).not.toBe(sizeBefore);
    expect(body[0]!.status).toBe('open');
    expect(body[0]!.marginMode).toBe('isolated');

    await app.close();
  });
});
