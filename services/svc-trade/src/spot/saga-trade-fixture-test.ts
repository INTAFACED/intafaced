/**
 * TEST SUPPORT for the SAGATEST replays of svc-trade's money doors (`saga.*.money.test.ts`).
 *
 * One real Postgres database per test file, the production `TradeService` over a ledger the test chooses (the in-memory
 * ledger to build state, the real HTTP ledger client over the harness fetch to run the door), and a scriptable matching
 * stub that survives a "crash" the way the engine does. The market id is pinned: orders and fills derive their ids, and
 * so their idempotency keys, from it, and a fresh market row would otherwise get a new random id on every replay.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { parseAmount as amt, recipes, type LedgerClient, type MemoryLedger } from '@intafaced/ledger-client';
import { TradeService } from '../controls/test-admission.js';
import { PUBLISHED_TEST_FEE_SCHEDULE, READY_MARKET_LIFECYCLE, StubMatching, StubPerks } from './testing.js';
import type { Market } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
export const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

export const SECRET = 'svc-trade-test-secret-0123456789';
export const ALICE = '11111111-1111-4111-8111-111111111111';
export const BOB = '22222222-2222-4222-8222-222222222222';
export const MARKET_ID = '77777777-7777-4777-8777-777777777777';

export async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_saga_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

export async function openTradeDatabase(): Promise<{ db: TestDatabase; stop: () => Promise<void> }> {
  const admin = await openAdmin();
  const db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
  return { db, stop: admin.stop };
}

/** The production service over `ledger`. The matching stub is passed in so it outlives a simulated crash. */
export function tradeOver(db: TestDatabase, ledger: LedgerClient, matching: StubMatching): TradeService {
  return new TradeService(db.sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
    marketLifecycle: READY_MARKET_LIFECYCLE,
    spotEnabled: true,
    marketSlippageCapBps: 150,
    feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
  });
}

/** Empty the trade tables, list BTC/USDT under the pinned market id, and return it. */
export async function resetAndListMarket(db: TestDatabase, ledger: MemoryLedger, matching: StubMatching): Promise<Market> {
  await db.sql`TRUNCATE trade.convert_quotes, trade.order_replace_requests, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
  const listed = await tradeOver(db, ledger, matching).listMarket({
    symbol: 'BTC/USDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    tickSize: amt('0.01'),
    lotSize: amt('0.0001'),
    minQty: amt('0.0001'),
    maxQty: amt('1000'),
    minNotional: amt('1'),
    makerBps: 10,
    takerBps: 20,
  });
  await db.sql`UPDATE trade.markets SET id = ${MARKET_ID} WHERE id = ${listed.id}`;
  return { ...listed, id: MARKET_ID };
}

/** Book a deposit under a fixed rail reference, the way a rail would. */
export async function fund(ledger: MemoryLedger, userId: string, assetId: string, amount: string): Promise<void> {
  await ledger.post(recipes.deposit({ userId, assetId, amount: amt(amount), rail: 'test', railRef: `saga-trade:${userId}:${assetId}` }));
}

const CREDIT_KEYS = ['TRADE_MAX_ORDER', 'TRADE_MAX_POSITION', 'TRADE_MAX_LOSS'] as const;

/**
 * The production client (`../ledger-client.js`) installs the pre-trade credit mill, which refuses new risk while the
 * owner limits are blank. A replay needs the order admitted, so these TEST limits are published for the file and put
 * back afterwards. They are fixtures, not a statement about any real limit.
 */
export function publishTestCreditLimits(): () => void {
  const before = CREDIT_KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of CREDIT_KEYS) process.env[k] = '1000000';
  return () => {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}
