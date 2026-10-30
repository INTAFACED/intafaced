/**
 * TWAP random sizes and trigger price survive a restart (real PostgreSQL): the seed, the trigger and its direction,
 * the planned sizes and the trigger instant are read back from `trade.algo_parents`. Rows are TEST parents.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { TradeService } from '../controls/test-admission.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, PUBLISHED_TEST_FEE_SCHEDULE } from '../spot/testing.js';
import { SqlTwapParentStore } from './parent-store.js';
import { planTwapSlices } from './schedule.js';
import type { TwapParent } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is required (runs/test-db.env). This suite does not start Docker.');
  const url = new URL(raw);
  if (url.pathname === '/test') url.pathname = '/intafaced_test';
  return url.toString();
}

const ALICE = '11111111-1111-4111-8111-111111111111';
let MARKET = '';
const LOT = parseAmount('0.0001');

function parent(over: Partial<TwapParent> = {}): TwapParent {
  const at = new Date('2026-10-29T12:00:00.000Z');
  return {
    id: 'p-random-trigger',
    userId: ALICE,
    subAccountId: null,
    marketId: MARKET,
    symbol: 'BTC/USDT',
    side: 'buy',
    kind: 'twap',
    status: 'active',
    totalQty: parseAmount('0.003'),
    durationMs: 300_000,
    sliceIntervalMs: 30_000,
    limitPrice: null,
    createdAt: at,
    startedAt: at,
    nextDueAt: at,
    projectedEndsAt: new Date(at.getTime() + 300_000),
    scheduleStretchReason: null,
    pausedAt: null,
    haltReason: null,
    lotSize: LOT,
    participationBps: null,
    slicesPlanned: 10,
    nextSliceIndex: 0,
    children: [],
    misses: [],
    randomSeed: 2310,
    triggerPrice: parseAmount('150000'),
    triggerAbove: true,
    triggeredAt: null,
    ...over,
  };
}

describe('TWAP random sizes and trigger in the parent store (shared test postgres)', () => {
  let db: TestDatabase;
  let sql: TestDatabase['sql'];

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: testDatabaseUrl(), migrations });
    sql = db.sql;
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    await sql`TRUNCATE trade.fills, trade.orders, trade.algo_parents, trade.markets RESTART IDENTITY CASCADE`;
    const trade = new TradeService(sql, new MemoryLedger(), new StubMatching(), new StubPerks(), new MemoryEventBus('svc-trade'), {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 200,
    });
    const market = await trade.listMarket({
      symbol: 'BTC/USDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      tickSize: parseAmount('0.01'),
      lotSize: LOT,
      minQty: LOT,
      maxQty: parseAmount('1000'),
      minNotional: parseAmount('0.01'),
      makerBps: 10,
      takerBps: 20,
    });
    MARKET = market.id;
  });

  const plan = planTwapSlices({
    totalQty: parseAmount('0.003'),
    durationMs: 300_000,
    sliceIntervalMs: 30_000,
    lotSize: LOT,
    randomSeed: 2310,
  }).slices;

  it('reads back the seed, the trigger, its direction and the planned sizes', async () => {
    const store = new SqlTwapParentStore(sql);
    await store.save({ parent: parent(), plan });
    const back = await new SqlTwapParentStore(sql).load('p-random-trigger');
    expect(back?.parent.randomSeed).toBe(2310);
    expect(back?.parent.triggerPrice).toBe(parseAmount('150000'));
    expect(back?.parent.triggerAbove).toBe(true);
    expect(back?.parent.triggeredAt).toBeNull();
    expect(back?.plan).toEqual(plan);
  });

  it('keeps the first trigger instant: a later save cannot clear or move it', async () => {
    const store = new SqlTwapParentStore(sql);
    const reached = new Date('2026-10-29T12:05:00.000Z');
    await store.save({ parent: parent(), plan });
    await store.save({ parent: parent({ triggeredAt: reached }), plan });
    expect((await store.load('p-random-trigger'))?.parent.triggeredAt?.toISOString()).toBe(reached.toISOString());
    await store.save({ parent: parent({ triggeredAt: null }), plan });
    expect((await store.load('p-random-trigger'))?.parent.triggeredAt?.toISOString()).toBe(reached.toISOString());
    await store.save({ parent: parent({ triggeredAt: new Date('2026-10-29T12:09:00.000Z') }), plan });
    expect((await store.load('p-random-trigger'))?.parent.triggeredAt?.toISOString()).toBe(reached.toISOString());
  });

  it('a parent without the options reads back without them', async () => {
    const store = new SqlTwapParentStore(sql);
    await store.save({ parent: parent({ randomSeed: null, triggerPrice: null, triggerAbove: null }), plan });
    const back = await store.load('p-random-trigger');
    expect(back?.parent.randomSeed).toBeNull();
    expect(back?.parent.triggerPrice).toBeNull();
    expect(back?.parent.triggerAbove).toBeNull();
  });

  it('the table refuses a trigger with no direction and a seed on another kind', async () => {
    const store = new SqlTwapParentStore(sql);
    await expect(store.save({ parent: parent({ triggerAbove: null }), plan })).rejects.toThrow(/algo_parents_random_trigger_ck/);
    await expect(
      store.save({ parent: parent({ kind: 'pov', participationBps: 100, triggerPrice: null, triggerAbove: null }), plan }),
    ).rejects.toThrow(/algo_parents_random_trigger_ck/);
  });
});
