/**
 * SP-conditional-algo-03 (J-cex-spot-09 step 3, backend): a TWAP parent is keyed
 * on the whole user id and the clientAlgoId. Real TradeService, real PostgreSQL.
 *
 * Before this slice the id was `algo-<first 8 chars of userId>-<clientAlgoId>`:
 * two users sharing a prefix collided (ENGINE D-5), and a long clientAlgoId made
 * the child client order id longer than the 64-character order limit.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IdentityOperationDecision, type IdentityOperationDecisionPort } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { TradingControls } from '../controls/trading-controls.js';
import { TradeService } from '../spot/trade-service.js';
import { PUBLISHED_TEST_FEE_SCHEDULE, READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor } from '../spot/testing.js';
import { truncateTradeExceptOrderEvents, parentIdFromClientOrder } from '../orders/order-events.js';
import { SqlTwapParentStore } from './parent-store.js';
import { algoParentId, legacyAlgoParentId } from './twap-engine.js';

// Same first eight characters, different users.
const ALICE = 'a1111111-1111-4111-8111-111111111111';
const AMOS = 'a1111111-2222-4222-8222-222222222222';
const NOW = new Date('2026-08-24T16:00:00.000Z');

describe('TWAP parent id: whole user id + clientAlgoId (isolated PostgreSQL)', () => {
  let db: TestDatabase;
  let ledger: MemoryLedger;
  let matching: StubMatching;
  let trade: TradeService;
  let marketId: string;
  const previousJobs = process.env.TRADE_ALGO_JOBS_ENABLED;

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

  afterEach(() => {
    if (previousJobs === undefined) delete process.env.TRADE_ALGO_JOBS_ENABLED;
    else process.env.TRADE_ALGO_JOBS_ENABLED = previousJobs;
  });

  beforeEach(async () => {
    await truncateTradeExceptOrderEvents(db.sql);
    ledger = new MemoryLedger();
    matching = new StubMatching();
    matching.bids = [['59990', '10']];
    matching.asks = [['60000', '10']];
    // Same granting identity double as create-gate.test.ts.
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
    trade = new TradeService(db.sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
      accountAdmission: controls,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketSlippageCapBps: 100,
      now: () => NOW,
    });
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

  async function fund(userId: string, amount: string) {
    await ledger.post(recipes.deposit({ userId, assetId: 'USDT', amount: amt(amount), rail: 'test', railRef: randomUUID() }));
  }

  async function parentRows() {
    return db.sql<Array<{ id: string; user_id: string; status: string }>>`
      SELECT id, user_id, status::text AS status FROM trade.algo_parents ORDER BY user_id`;
  }

  function schedule(clientAlgoId: string) {
    return {
      marketId,
      side: 'buy' as const,
      totalQty: amt('0.01'),
      durationMs: 60_000,
      sliceIntervalMs: 60_000,
      limitPrice: amt('60000'),
      clientAlgoId,
    };
  }

  it('journey step 3: create, retry returns the same parent, then pause, resume and cancel are each answered', async () => {
    await fund(ALICE, '1000');
    const created = await trade.createTwap(principalFor(ALICE), schedule('step-3'));
    expect(created.id).toBe(algoParentId(ALICE, 'step-3'));
    expect(created.status).toBe('active');

    const retried = await trade.createTwap(principalFor(ALICE), schedule('step-3'));
    expect(retried.id).toBe(created.id);
    expect(await parentRows()).toEqual([{ id: created.id, user_id: ALICE, status: 'active' }]);

    expect((await trade.pauseAlgo(principalFor(ALICE), created.id)).status).toBe('paused');
    expect((await parentRows())[0]?.status).toBe('paused');
    expect((await trade.resumeAlgo(principalFor(ALICE), created.id)).status).toBe('active');
    expect((await parentRows())[0]?.status).toBe('active');
    expect((await trade.cancelAlgo(principalFor(ALICE), created.id)).status).toBe('cancelled');
    expect((await parentRows())[0]?.status).toBe('cancelled');
    const progress = await trade.algoProgress(principalFor(ALICE, ['trade:read', 'trade:write']), created.id);
    expect(progress.status).toBe('cancelled');
    expect(progress.childrenEmitted).toBe(0);
  });

  it('two users with the same 8-character id prefix and the same clientAlgoId get two parents (D-5)', async () => {
    await fund(ALICE, '1000');
    await fund(AMOS, '1000');
    expect(legacyAlgoParentId(ALICE, 'shared')).toBe(legacyAlgoParentId(AMOS, 'shared'));

    const a = await trade.createTwap(principalFor(ALICE), schedule('shared'));
    const b = await trade.createTwap(principalFor(AMOS), schedule('shared'));
    expect(a.id).not.toBe(b.id);
    expect(a.userId).toBe(ALICE);
    expect(b.userId).toBe(AMOS);
    expect((await parentRows()).map((r) => r.user_id)).toEqual([ALICE, AMOS]);

    // Each retry returns the caller's own parent, never the other user's.
    expect((await trade.createTwap(principalFor(ALICE), schedule('shared'))).id).toBe(a.id);
    expect((await trade.createTwap(principalFor(AMOS), schedule('shared'))).id).toBe(b.id);
    expect(await parentRows()).toHaveLength(2);
  });

  it('a 48-character clientAlgoId places its first child with a client order id inside the 64-character limit', async () => {
    process.env.TRADE_ALGO_JOBS_ENABLED = 'true';
    await fund(ALICE, '1000');
    const longId = 'x'.repeat(48);
    const parent = await trade.createTwap(principalFor(ALICE), schedule(longId));
    await trade.tickAlgo(parent.id);

    const orders = await db.sql<Array<{ client_order_id: string }>>`
      SELECT client_order_id FROM trade.orders WHERE user_id = ${ALICE}`;
    expect(orders).toHaveLength(1);
    const clientOrderId = orders[0]!.client_order_id;
    expect(clientOrderId.length).toBeLessThanOrEqual(64);
    expect(parentIdFromClientOrder(clientOrderId)).toBe(parent.id);
    const progress = await trade.algoProgress(principalFor(ALICE, ['trade:read', 'trade:write']), parent.id);
    expect(progress.childrenEmitted).toBe(1);
    expect(progress.missesRecorded).toBe(0);
  });

  it('a retry of a create stored under the old id formula returns that parent and stores no second one', async () => {
    await fund(ALICE, '1000');
    const store = new SqlTwapParentStore(db.sql);
    const legacy = legacyAlgoParentId(ALICE, 'old-create');
    await store.save({
      parent: {
        id: legacy,
        userId: ALICE,
        subAccountId: null,
        marketId,
        symbol: 'BTC/USDT',
        side: 'buy',
        kind: 'twap',
        status: 'active',
        totalQty: amt('0.01'),
        durationMs: 60_000,
        sliceIntervalMs: 60_000,
        limitPrice: amt('60000'),
        createdAt: NOW,
        startedAt: NOW,
        nextDueAt: NOW,
        projectedEndsAt: NOW,
        scheduleStretchReason: null,
        pausedAt: null,
        haltReason: null,
        lotSize: amt('0.001'),
        participationBps: null,
        slicesPlanned: 1,
        nextSliceIndex: 0,
        children: [],
        misses: [],
      },
      plan: [amt('0.01')],
    });
    const again = await trade.createTwap(principalFor(ALICE), schedule('old-create'));
    expect(again.id).toBe(legacy);
    expect(await parentRows()).toEqual([{ id: legacy, user_id: ALICE, status: 'active' }]);
    // Another user with the same prefix does not adopt it.
    await fund(AMOS, '1000');
    const amos = await trade.createTwap(principalFor(AMOS), schedule('old-create'));
    expect(amos.id).toBe(algoParentId(AMOS, 'old-create'));
  });
});
