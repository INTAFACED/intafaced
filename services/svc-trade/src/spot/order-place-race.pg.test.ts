/**
 * One order submitted many times at once. The order id is made from (user, market, client id), so the id and
 * `orders_client_id_idx` always name the same row: every loser of the insert race must get the row that won, never a
 * 23505 on the client-id key, and exactly one hold is posted.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TradeService } from '../controls/test-admission.js';
import { PUBLISHED_TEST_FEE_SCHEDULE, READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor } from './testing.js';
import type { Market } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_order_place_race_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const ROUNDS = 100;
const AT_ONCE = 8;

describe('order place race (PG-hard)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;

  beforeAll(async () => {
    const admin = await openAdmin();
    stop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
    await stop();
  }, 30_000);

  async function setup(paper: boolean) {
    await db.sql`TRUNCATE trade.order_replace_requests, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    const ledger = new MemoryLedger();
    const trade = new TradeService(db.sql, ledger, new StubMatching(), new StubPerks(), new MemoryEventBus('svc-trade'), {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 200,
    });
    const listed: Market = await trade.listMarket({
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
    if (paper) await db.sql`UPDATE trade.markets SET paper = true WHERE id = ${listed.id}`;
    await ledger.post(recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('100000'), rail: 'test', railRef: 'race:u' }));
    return { trade, ledger, market: listed };
  }

  const alice = principalFor(ALICE, ['trade:read', 'trade:write']);

  for (const paper of [false, true]) {
    it(`${paper ? 'a paper' : 'a live'} order sent ${AT_ONCE} times at once: every call returns the one stored order, never 23505`, async () => {
      const { trade, ledger, market } = await setup(paper);
      for (let round = 0; round < ROUNDS; round += 1) {
        const input = {
          marketId: market.id,
          side: 'buy' as const,
          type: 'limit',
          qty: amt('1'),
          price: amt('50'),
          clientOrderId: `race-${paper ? 'p' : 'l'}-${round}`,
        };
        const settled = await Promise.allSettled(Array.from({ length: AT_ONCE }, () => trade.placeOrder(alice, input)));
        const failures = settled.flatMap((s) => (s.status === 'rejected' ? [String((s.reason as Error)?.message ?? s.reason)] : []));
        expect(failures, `round ${round}`).toEqual([]);
        const ids = new Set(settled.map((s) => (s as PromiseFulfilledResult<{ id: string }>).value.id));
        expect(ids.size).toBe(1);
        const rows = await db.sql<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM trade.orders WHERE user_id = ${ALICE} AND client_order_id = ${input.clientOrderId}
        `;
        expect(rows[0]?.n).toBe(1);
        // One hold per order on a live market, none on a paper market.
        const [id] = [...ids];
        expect(ledger.journal().filter((tx) => tx.idempotencyKey === `order.hold:${id}`)).toHaveLength(paper ? 0 : 1);
      }
    }, 120_000);
  }
});
