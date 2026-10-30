/**
 * algo.createTwap refuses, before any parent is stored, a schedule that cannot
 * place its first slice. Balance is a read. Nothing is held.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import type { Principal } from '@intafaced/auth';
import {
  createEdgeContext,
  encodePrincipal,
  signPrincipalHeader,
  type IdentityOperationDecision,
  type IdentityOperationDecisionPort,
} from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { formatAmount, MemoryLedger, mulBps, parseAmount as amt, recipes, userAvailable, type AccountRef } from '@intafaced/ledger-client';
import { TradingControls } from '../controls/trading-controls.js';
import { createTradeRouter, type TradeRouter } from '../router.js';
import { ratesForFill } from '../spot/fees.js';
import { type OwnerFeeSchedule } from '../spot/fee-schedule.js';
import { TradeService } from '../spot/trade-service.js';
import {
  PUBLISHED_TEST_FEE_SCHEDULE,
  READY_MARKET_LIFECYCLE,
  StubEmailProof,
  StubMatching,
  StubPerks,
  principalFor,
} from '../spot/testing.js';
import { TradeError } from '../spot/types.js';
import { truncateTradeExceptOrderEvents } from '../orders/order-events.js';
import { ALGO_IMMATURE_KINDS, ALGO_VOLUME_IMMATURE_CODE, describeAlgoPolicy } from './algo-policy.js';
import { withinPriceBand } from './mark-gate.js';

const ALICE = 'a1111111-1111-4111-8111-111111111111';
const BOB = 'b2222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-08-24T16:00:00.000Z');
const EDGE_SECRET = 'a-trade-algo-create-gate-edge-secret-32';

class FlakyLedger extends MemoryLedger {
  failBalance = false;
  override async balance(ref: AccountRef) {
    if (this.failBalance) throw new Error('balance unread');
    return super.balance(ref);
  }
}

describe('algo.createTwap creation gate (isolated PostgreSQL)', () => {
  let db: TestDatabase;
  let ledger: FlakyLedger;
  let matching: StubMatching;
  let perks: StubPerks;
  let trade: TradeService;
  let marketId: string;
  let seq = 0;
  const edgeContext = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-trade' });

  function build(options: { feeSchedule?: OwnerFeeSchedule; algoMarkPolicy?: { maxAgeSeconds: number } } = {}) {
    const identityRows = new Map<string, IdentityOperationDecision>();
    const identity: IdentityOperationDecisionPort = {
      async decide({ mode, intent }) {
        const key = intent.operation.userId + ':' + intent.businessId;
        const old = identityRows.get(key);
        if (old) return old;
        const result: IdentityOperationDecision =
          mode === 'grant'
            ? { status: 'granted', intent, grantId: randomUUID(), identityVersion: '0', decidedAt: new Date().toISOString() }
            : { status: 'cancelled', intent, code: 'admission.cancelled', decidedAt: new Date().toISOString() };
        identityRows.set(key, result);
        return result;
      },
    };
    const controls = new TradingControls(db.sql, { check: async () => 'enabled' }, identity);
    return new TradeService(db.sql, ledger, matching, perks, new MemoryEventBus('svc-trade'), {
      emailProof: new StubEmailProof(),
      accountAdmission: controls,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      // CB-bots-10: the bot verification gate now fails closed when omitted; this suite tests other gates.
      botVerification: { mode: 'off' },
      feeSchedule: options.feeSchedule === undefined ? PUBLISHED_TEST_FEE_SCHEDULE : options.feeSchedule,
      marketSlippageCapBps: 100,
      algoMarkPolicy: options.algoMarkPolicy,
      now: () => NOW,
    });
  }

  beforeAll(async () => {
    const directory = new URL('../../drizzle/', import.meta.url);
    const migrations = readdirSync(directory)
      .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
      .sort()
      .map((name) => readFileSync(new URL(name, directory), 'utf8'));
    db = await createTestDatabase({ service: 'trade', migrations });
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    // order_events refuses TRUNCATE. Same reset as the copy SQL suites.
    await truncateTradeExceptOrderEvents(db.sql);
    ledger = new FlakyLedger();
    matching = new StubMatching();
    perks = new StubPerks();
    matching.bids = [['59990', '10']];
    matching.asks = [['60000', '10']];
    seq = 0;
    trade = build();
    const market = await trade.listMarket({
      symbol: 'BTC/USDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      tickSize: amt('0.01'),
      lotSize: amt('0.001'),
      minQty: amt('0.001'),
      maxQty: amt('10000'),
      minNotional: amt('1'),
      makerBps: 10,
      takerBps: 20,
    });
    marketId = market.id;
  });

  async function fund(userId: string, assetId: string, amount: string) {
    await ledger.post(recipes.deposit({ userId, assetId, amount: amt(amount), rail: 'test', railRef: randomUUID() }));
  }

  async function available(userId: string, assetId: string) {
    return formatAmount((await ledger.balance(userAvailable(userId, assetId))).amount);
  }

  async function counts() {
    const parents = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.algo_parents`;
    const intents = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.operation_intents`;
    return { parents: parents[0]?.n ?? '0', intents: intents[0]?.n ?? '0' };
  }

  function schedule(overrides: Record<string, unknown> = {}) {
    return {
      marketId,
      side: 'buy' as const,
      totalQty: amt('0.01'),
      durationMs: 60_000,
      sliceIntervalMs: 60_000,
      limitPrice: amt('60000'),
      clientAlgoId: randomUUID().slice(0, 12),
      ...overrides,
    };
  }

  async function tape(qty: string, ts: number) {
    const a = randomUUID();
    const b = randomUUID();
    const session = '99999999-9999-4999-8999-999999999999';
    for (const id of [a, b]) {
      await db.sql`
        INSERT INTO trade.orders (
          id, user_id, market_id, side, type, price, qty, status, tif, hold_asset, hold_amount, fee_discount_bps, session_id, seeded
        ) VALUES (
          ${id}, ${BOB}, ${marketId}, 'sell', 'limit', ${'60000'}::numeric, ${qty}::numeric,
          'filled', 'GTC', 'BTC', ${'1'}::numeric, 0, ${session}, false
        )`;
    }
    seq += 1;
    await db.sql`
      INSERT INTO trade.fills (
        id, order_id, counter_order_id, market_id, user_id, side, liquidity,
        price, qty, quote_amount, fee_asset, fee_amount, fee_bps, sequence, ts
      ) VALUES (
        ${randomUUID()}, ${a}, ${b}, ${marketId}, ${BOB}, 'sell', 'taker',
        ${'60000'}::numeric, ${qty}::numeric, ${'600'}::numeric, 'USDT', ${'0'}::numeric, 0, ${seq}, ${new Date(ts)}
      )`;
  }

  it('refuses a buy of 1000 BTC when the first slice is not covered, and stores nothing', async () => {
    await fund(ALICE, 'USDT', '100');
    await fund(BOB, 'USDT', '1000000');
    const before = await counts();
    const journal = ledger.journal().length;
    const bob = await available(BOB, 'USDT');
    let caught: TradeError | undefined;
    try {
      await trade.createTwap(principalFor(ALICE), schedule({ totalQty: amt('1000'), clientAlgoId: 'thousand' }));
    } catch (err) {
      caught = err as TradeError;
    }
    expect(caught?.code).toBe('trade.algo_insufficient_balance');
    expect(caught?.data).toEqual({
      asset: 'USDT',
      required: '60000000',
      available: '100',
      fee: '2',
      feeAsset: 'BTC',
      sliceQty: '1000',
    });
    const rates = ratesForFill(PUBLISHED_TEST_FEE_SCHEDULE, 0, 0, 'spot');
    expect(rates.takerFeeBps).toBe(20);
    expect(formatAmount(mulBps(amt('1000'), 20))).toBe('2');
    expect(caught?.data?.fee).toBe('2');
    expect(await counts()).toEqual(before);
    expect(ledger.journal()).toHaveLength(journal);
    expect(await available(ALICE, 'USDT')).toBe('100');
    expect(await available(BOB, 'USDT')).toBe(bob);
  });

  it('accepts a schedule whose first slice is covered and whose total is not, and holds nothing', async () => {
    await fund(ALICE, 'USDT', '150');
    matching.bids = [['100', '10']];
    matching.asks = [['100', '10']];
    const journal = ledger.journal().length;
    const parent = await trade.createTwap(
      principalFor(ALICE),
      schedule({
        totalQty: amt('2'),
        durationMs: 120_000,
        sliceIntervalMs: 60_000,
        limitPrice: amt('100'),
        clientAlgoId: 'first-only',
      }),
    );
    expect(parent.status).toBe('active');
    expect(parent.slicesPlanned).toBe(2);
    expect(await available(ALICE, 'USDT')).toBe('150');
    expect(ledger.journal()).toHaveLength(journal);
    expect((await counts()).parents).toBe('1');
  });

  it('refuses a sell above the base balance', async () => {
    await fund(ALICE, 'BTC', '1');
    matching.bids = [['60000', '10']];
    matching.asks = [['60001', '10']];
    const before = await counts();
    await expect(
      trade.createTwap(
        principalFor(ALICE),
        schedule({ side: 'sell', totalQty: amt('5'), limitPrice: amt('60000'), clientAlgoId: 'sell-short' }),
      ),
    ).rejects.toMatchObject({
      code: 'trade.algo_insufficient_balance',
      data: { asset: 'BTC', required: '5', available: '1', feeAsset: 'USDT', sliceQty: '5' },
    });
    // 5 BTC at the 60000 touch, taker 20 bps of the quote, is 600 USDT. Child fill uses the same mulBps.
    const sellFee = formatAmount(mulBps(amt('300000'), 20));
    expect(sellFee).toBe('600');
    await expect(
      trade.createTwap(
        principalFor(ALICE),
        schedule({ side: 'sell', totalQty: amt('5'), limitPrice: amt('60000'), clientAlgoId: 'sell-short-2' }),
      ),
    ).rejects.toMatchObject({ data: { fee: '600' } });
    expect(await counts()).toEqual(before);
    expect(await available(ALICE, 'BTC')).toBe('1');
  });

  it('uses the caller discount the child fill would snapshot', async () => {
    await fund(ALICE, 'USDT', '10');
    perks.discounts.set(ALICE, 5_000);
    matching.bids = [['100', '10']];
    matching.asks = [['100', '10']];
    await expect(
      trade.createTwap(principalFor(ALICE), schedule({ totalQty: amt('1'), limitPrice: amt('100'), clientAlgoId: 'discounted' })),
    ).rejects.toMatchObject({
      code: 'trade.algo_insufficient_balance',
      data: { required: '100', available: '10', fee: '0.001', feeAsset: 'BTC', sliceQty: '1' },
    });
  });

  it('refuses when the balance read fails, and does not treat that as enough', async () => {
    await fund(ALICE, 'USDT', '100000000');
    ledger.failBalance = true;
    const before = await counts();
    await expect(trade.createTwap(principalFor(ALICE), schedule({ clientAlgoId: 'unread' }))).rejects.toMatchObject({
      code: 'trade.algo_balance_unreadable',
      data: { asset: 'USDT' },
    });
    expect(await counts()).toEqual(before);
  });

  it('refuses a limit of 1 against a market near 60000 with the band code', async () => {
    await fund(ALICE, 'USDT', '100000000');
    const before = await counts();
    await expect(
      trade.createTwap(principalFor(ALICE), schedule({ limitPrice: amt('1'), clientAlgoId: 'limit-one' })),
    ).rejects.toMatchObject({ code: 'trade.algo_price_band' });
    expect(withinPriceBand('buy', amt('60000'), amt('1'))).toBe(false);
    expect(await counts()).toEqual(before);
  });

  it('refuses a trigger at the current mark and stores nothing; one above or below fixes its direction', async () => {
    await fund(ALICE, 'USDT', '10000');
    const before = await counts();
    // The mark is the mid of 59990 and 60000.
    await expect(
      trade.createTwap(principalFor(ALICE), schedule({ limitPrice: null, triggerPrice: amt('59995'), clientAlgoId: 'trigger-at-mid' })),
    ).rejects.toMatchObject({ code: 'trade.algo_invalid_schedule' });
    expect(await counts()).toEqual(before);
    const above = await trade.createTwap(
      principalFor(ALICE),
      schedule({ limitPrice: null, triggerPrice: amt('61000'), clientAlgoId: 'trigger-up' }),
    );
    expect(above.triggerAbove).toBe(true);
    expect(above.triggeredAt).toBeNull();
    const below = await trade.createTwap(
      principalFor(ALICE),
      schedule({ limitPrice: null, triggerPrice: amt('59000'), clientAlgoId: 'trigger-down' }),
    );
    expect(below.triggerAbove).toBe(false);
  });

  it('the size preview for a seed is the plan a create with that seed stores', async () => {
    await fund(ALICE, 'USDT', '100000');
    const shape = { totalQty: amt('0.05'), durationMs: 300_000, sliceIntervalMs: 30_000 };
    const preview = await trade.previewTwapSizes(principalFor(ALICE, ['trade:read']), { symbol: 'BTC/USDT', ...shape, randomSeed: 2310 });
    const parent = await trade.createTwap(principalFor(ALICE), schedule({ ...shape, randomSeed: 2310, clientAlgoId: 'seeded-plan' }));
    expect(await trade.algoPlan(principalFor(ALICE, ['trade:read']), parent.id)).toEqual(preview);
    expect(new Set(preview.map(String)).size).toBeGreaterThan(1);
    expect(preview.reduce((sum, q) => sum + q, 0n)).toBe(amt('0.05'));
  });

  it('accepts a limit inside the band', async () => {
    await fund(ALICE, 'USDT', '1000');
    const parent = await trade.createTwap(principalFor(ALICE), schedule({ limitPrice: amt('60000'), clientAlgoId: 'inside' }));
    expect(parent.status).toBe('active');
    expect(withinPriceBand('buy', amt('60000'), amt('60000'))).toBe(true);
  });

  it('judges a sell limit far above the bid with the same function as the slice gate', async () => {
    await fund(ALICE, 'BTC', '1');
    expect(withinPriceBand('sell', amt('59990'), amt('120000'))).toBe(false);
    const before = await counts();
    await expect(
      trade.createTwap(
        principalFor(ALICE),
        schedule({ side: 'sell', limitPrice: amt('120000'), totalQty: amt('0.01'), clientAlgoId: 'sell-high' }),
      ),
    ).rejects.toMatchObject({ code: 'trade.algo_price_band' });
    expect(await counts()).toEqual(before);
    const parent = await trade.createTwap(
      principalFor(ALICE),
      schedule({ side: 'sell', limitPrice: amt('59990'), totalQty: amt('0.01'), clientAlgoId: 'sell-touch' }),
    );
    expect(parent.status).toBe('active');
    expect(withinPriceBand('sell', amt('59990'), amt('59990'))).toBe(true);
  });

  it('skips the band check when there is no limit', async () => {
    await fund(ALICE, 'USDT', '1000');
    const parent = await trade.createTwap(
      principalFor(ALICE),
      schedule({ limitPrice: null, totalQty: amt('0.001'), clientAlgoId: 'market-child' }),
    );
    expect(parent.status).toBe('active');
    expect(parent.limitPrice).toBeNull();
  });

  it('refuses a non-positive reference with the mark code, and a blank mark policy by name', async () => {
    await fund(ALICE, 'USDT', '1000');
    matching.bids = [['0', '1']];
    const before = await counts();
    await expect(trade.createTwap(principalFor(ALICE), schedule({ clientAlgoId: 'bad-bid' }))).rejects.toMatchObject({
      code: 'trade.algo_mark_invalid',
    });
    expect(await counts()).toEqual(before);
    const blank = build({ algoMarkPolicy: { maxAgeSeconds: Number.NaN } });
    await expect(blank.createTwap(principalFor(ALICE), schedule({ clientAlgoId: 'blank-policy' }))).rejects.toMatchObject({
      code: 'trade.algo_mark_policy_unset',
      message: expect.stringContaining('maxAgeSeconds'),
    });
    expect(await counts()).toEqual(before);
  });

  it('refuses an unpublished fee schedule by the missing key', async () => {
    await fund(ALICE, 'USDT', '1000');
    const closed = build({ feeSchedule: { published: false } });
    const before = await counts();
    await expect(closed.createTwap(principalFor(ALICE), schedule({ clientAlgoId: 'no-fee' }))).rejects.toMatchObject({
      code: 'trade.fee_schedule_blank',
      message: expect.stringContaining('TRADE_FEE_SCHEDULE'),
    });
    expect(await counts()).toEqual(before);
  });

  it('refuses every immature kind at create, and leaves TWAP alone', async () => {
    expect(describeAlgoPolicy().vwapPovImmatureRefused).toBe(true);
    expect(describeAlgoPolicy().volumeImmatureCode).toBe(ALGO_VOLUME_IMMATURE_CODE);
    await fund(ALICE, 'USDT', '100000');
    const before = await counts();
    for (const kind of ALGO_IMMATURE_KINDS) {
      await expect(
        trade.createTwap(
          principalFor(ALICE),
          schedule({
            kind,
            participationBps: kind === 'pov' ? 10_000 : undefined,
            clientAlgoId: `immature-${kind}`,
          }),
        ),
      ).rejects.toMatchObject({ code: ALGO_VOLUME_IMMATURE_CODE });
    }
    expect(await counts()).toEqual(before);
    const twap = await trade.createTwap(principalFor(ALICE), schedule({ kind: 'twap', clientAlgoId: 'twap-quiet' }));
    expect(twap.status).toBe('active');
    expect(twap.kind).toBe('twap');
  });

  it('accepts a VWAP with observed volume and a POV with recent tape', async () => {
    await fund(ALICE, 'USDT', '10000');
    await tape('0.01', NOW.getTime() - 30_000);
    const vwap = await trade.createTwap(principalFor(ALICE), schedule({ kind: 'vwap', totalQty: amt('0.01'), clientAlgoId: 'vwap-live' }));
    expect(vwap.status).toBe('active');
    expect(vwap.kind).toBe('vwap');
    const pov = await trade.createTwap(
      principalFor(ALICE),
      schedule({ kind: 'pov', totalQty: amt('0.01'), participationBps: 10_000, clientAlgoId: 'pov-live' }),
    );
    expect(pov.status).toBe('active');
    expect(pov.kind).toBe('pov');
    expect(await available(ALICE, 'USDT')).toBe('10000');
  });

  it('returns a stored parent on replay without re-reading the balance', async () => {
    await fund(ALICE, 'USDT', '1000');
    const parent = await trade.createTwap(principalFor(ALICE), schedule({ clientAlgoId: 'replay-me' }));
    const afterCreate = await counts();
    ledger.failBalance = true;
    const again = await trade.createTwap(
      principalFor(ALICE),
      schedule({ clientAlgoId: 'replay-me', totalQty: amt('1000'), limitPrice: amt('1') }),
    );
    expect(again.id).toBe(parent.id);
    expect(formatAmount(again.totalQty)).toBe('0.01');
    expect(await counts()).toEqual(afterCreate);
  });

  it('refuses a session without trade:write and stores nothing', async () => {
    await fund(ALICE, 'USDT', '1000');
    const before = await counts();
    await expect(trade.createTwap(principalFor(ALICE, ['trade:read']), schedule({ clientAlgoId: 'reader' }))).rejects.toMatchObject({
      code: 'scope.denied',
    });
    expect(await counts()).toEqual(before);
  });

  it('reaches the client with the same code and the decimal amounts', async () => {
    await fund(ALICE, 'USDT', '100');
    const router = createTradeRouter(trade);
    const app = Fastify({ logger: false });
    await app.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: {
        router,
        createContext: ({ req }) => edgeContext(req),
      } satisfies FastifyTRPCPluginOptions<TradeRouter>['trpcOptions'],
    });
    await app.ready();
    const principal: Principal = principalFor(ALICE);
    const raw = encodePrincipal(principal);
    const res = await app.inject({
      method: 'POST',
      url: '/trpc/algo.createTwap',
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      payload: {
        symbol: 'BTC/USDT',
        side: 'buy',
        totalQty: '1000',
        durationMs: 60_000,
        sliceIntervalMs: 60_000,
        limitPrice: '60000',
        clientAlgoId: 'wire-thousand',
      },
    });
    const body = res.json() as { error?: { data?: { cause?: { code?: string }; algo?: Record<string, string> } } };
    expect(body.error?.data?.cause?.code).toBe('trade.algo_insufficient_balance');
    expect(body.error?.data?.algo).toEqual({
      asset: 'USDT',
      required: '60000000',
      available: '100',
      fee: '2',
      feeAsset: 'BTC',
      sliceQty: '1000',
    });
    expect((await counts()).parents).toBe('0');
    await app.close();
  });
});
