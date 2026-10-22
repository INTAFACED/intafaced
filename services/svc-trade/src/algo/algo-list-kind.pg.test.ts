/**
 * CB-bots-01 — "My bots" kind filter on `trade.algo.list` (real PostgreSQL).
 * Rows are TEST parents written through the parent store.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { TradeService } from '../controls/test-admission.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from '../spot/testing.js';
import type { Market } from '../spot/types.js';
import { listAlgoParents, TRADE_ALGO_LIST_KIND_INVALID } from './algo-list.js';
import { SqlTwapParentStore } from './parent-store.js';
import type { AlgoKind, TwapParent } from './types.js';

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

function parentRow(id: string, kind: AlgoKind, marketId: string, createdAt: Date): TwapParent {
  return {
    id,
    userId: ALICE,
    subAccountId: null,
    marketId,
    symbol: 'BTC/USDT',
    side: 'buy',
    kind,
    status: 'active',
    totalQty: parseAmount('1'),
    durationMs: 60_000,
    sliceIntervalMs: 2_000,
    limitPrice: parseAmount('100'),
    createdAt,
    startedAt: createdAt,
    nextDueAt: createdAt,
    projectedEndsAt: createdAt,
    scheduleStretchReason: null,
    pausedAt: null,
    haltReason: null,
    lotSize: parseAmount('0.001'),
    participationBps: kind === 'pov' ? 100 : null,
    slicesPlanned: 1,
    nextSliceIndex: 0,
    children: [],
    misses: [],
  };
}

describe('algo list kind filter (shared test postgres)', () => {
  let db: TestDatabase;
  let sql: TestDatabase['sql'];
  let btc: Market;

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
    btc = await trade.listMarket({
      symbol: 'BTC/USDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      tickSize: parseAmount('0.01'),
      lotSize: parseAmount('0.001'),
      minQty: parseAmount('0.001'),
      maxQty: parseAmount('1000'),
      minNotional: parseAmount('0.01'),
      makerBps: 10,
      takerBps: 20,
    });
    const store = new SqlTwapParentStore(sql);
    const now = new Date();
    await store.save({ parent: parentRow('p-twap', 'twap', btc.id, new Date(now.getTime() - 2_000)), plan: [parseAmount('1')] });
    await store.save({ parent: parentRow('p-vwap', 'vwap', btc.id, new Date(now.getTime() - 1_000)), plan: [parseAmount('1')] });
  });

  const alice = () => principalFor(ALICE, ['trade:read']);

  it('no kind lists every bot', async () => {
    const page = await listAlgoParents(sql, alice(), { limit: 50 }, new Date());
    expect(page.rows.map((r) => r.id).sort()).toEqual(['p-twap', 'p-vwap']);
  });

  it('a kind lists only that kind', async () => {
    const page = await listAlgoParents(sql, alice(), { kind: 'vwap', limit: 50 }, new Date());
    expect(page.rows.map((r) => r.id)).toEqual(['p-vwap']);
  });

  it('grid lists empty until the grid engine ships', async () => {
    const page = await listAlgoParents(sql, alice(), { kind: 'grid', limit: 50 }, new Date());
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('kind combines with status and paging', async () => {
    const first = await listAlgoParents(sql, alice(), { kind: 'twap', status: 'active', limit: 1 }, new Date());
    expect(first.rows.map((r) => r.id)).toEqual(['p-twap']);
    expect(first.nextCursor).toBeNull();
    const paused = await listAlgoParents(sql, alice(), { kind: 'twap', status: 'paused', limit: 50 }, new Date());
    expect(paused.rows).toEqual([]);
  });

  it('an unknown kind refuses', async () => {
    await expect(listAlgoParents(sql, alice(), { kind: 'martingale', limit: 50 }, new Date())).rejects.toMatchObject({
      code: TRADE_ALGO_LIST_KIND_INVALID,
    });
  });
});
