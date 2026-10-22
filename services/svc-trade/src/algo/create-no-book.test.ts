/**
 * algo.createTwap on a market the matching engine holds no book for
 * (matching 404 → MatchingNoBookError) is a named refusal `trade.no_book`,
 * not an HTTP 500. Nothing is held, no parent row or operation intent is left.
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
import { formatAmount, MemoryLedger, parseAmount as amt, recipes, userAvailable, type AccountRef } from '@intafaced/ledger-client';
import { TradingControls } from '../controls/trading-controls.js';
import { createTradeRouter, type TradeRouter } from '../router.js';
import { type OwnerFeeSchedule } from '../spot/fee-schedule.js';
import { TradeService } from '../spot/trade-service.js';
import { PUBLISHED_TEST_FEE_SCHEDULE, READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor } from '../spot/testing.js';
import { TradeError } from '../spot/types.js';
import { MatchingNoBookError, type EngineDepth } from '../spot/matching-client.js';
import { truncateTradeExceptOrderEvents } from '../orders/order-events.js';

const ALICE = 'a1111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-08-24T16:00:00.000Z');
const EDGE_SECRET = 'a-trade-algo-create-gate-edge-secret-32';

class NoBookMatching extends StubMatching {
  noBook = false;
  override async depth(marketId?: string): Promise<EngineDepth> {
    if (this.noBook) throw new MatchingNoBookError(marketId ?? '');
    return super.depth();
  }
}

class FlakyLedger extends MemoryLedger {
  failBalance = false;
  override async balance(ref: AccountRef) {
    if (this.failBalance) throw new Error('balance unread');
    return super.balance(ref);
  }
}

describe('algo.createTwap with no matching book (isolated PostgreSQL)', () => {
  let db: TestDatabase;
  let ledger: FlakyLedger;
  let matching: NoBookMatching;
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
      accountAdmission: controls,
      marketLifecycle: READY_MARKET_LIFECYCLE,
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
    matching = new NoBookMatching();
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

  const schedule = (clientAlgoId: string) => ({
    marketId,
    side: 'buy' as const,
    totalQty: amt('0.01'),
    durationMs: 60_000,
    sliceIntervalMs: 60_000,
    limitPrice: amt('60000'),
    clientAlgoId,
  });

  it('refuses with trade.no_book, holds nothing and stores no parent', async () => {
    await fund(ALICE, 'USDT', '1000');
    matching.noBook = true;
    const refused = await trade.createTwap(principalFor(ALICE), schedule('no-book')).catch((err: unknown) => err);
    // A TradeError is a named refusal the router maps; a raw MatchingNoBookError is a 500.
    expect(refused).toBeInstanceOf(TradeError);
    expect(refused).toMatchObject({ code: 'trade.no_book' });
    expect(await available(ALICE, 'USDT')).toBe('1000');
    expect(await counts()).toEqual({ parents: '0', intents: '0' });
    // The same clientAlgoId is free to create once the book exists.
    matching.noBook = false;
    const parent = await trade.createTwap(principalFor(ALICE), schedule('no-book'));
    expect(parent.status).toBe('active');
  });

  it('reaches the wire as a named refusal, not a 500', async () => {
    await fund(ALICE, 'USDT', '1000');
    matching.noBook = true;
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
        totalQty: '0.01',
        durationMs: 60_000,
        sliceIntervalMs: 60_000,
        limitPrice: '60000',
        clientAlgoId: 'wire-no-book',
      },
    });
    expect(res.statusCode).not.toBe(500);
    const body = res.json() as { error?: { data?: { cause?: { code?: string } } } };
    expect(body.error?.data?.cause?.code).toBe('trade.no_book');
    expect(await counts()).toEqual({ parents: '0', intents: '0' });
    await app.close();
  });
});
