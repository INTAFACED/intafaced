import { TradeService } from '../controls/test-admission.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { formatAmount, MemoryLedger, parseAmount as amt, recipes, userAvailable, orderHoldAccount } from '@intafaced/ledger-client';

import { closeSpotPosition, installClosePosition } from './close-position.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from './testing.js';
import type { EngineSubmitResult } from './matching-client.js';
import type { MatchingCloseRequest } from './matching-close.js';
import type { Market } from './types.js';

installClosePosition(TradeService);

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: svc-trade close-position is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

class StubMatchingClose extends StubMatching {
  readonly closed: Array<{ marketId: string; request: MatchingCloseRequest }> = [];
  closeScript: ((marketId: string, request: MatchingCloseRequest) => EngineSubmitResult) | null = null;

  async closePosition(marketId: string, request: MatchingCloseRequest): Promise<EngineSubmitResult> {
    this.closed.push({ marketId, request });
    if (this.closeScript) return this.closeScript(marketId, request);
    return {
      accepted: false,
      sequence: null,
      fills: [],
      resting: null,
      rejected: { code: 'position_flat', message: 'account is flat on this book; the engine does not invent a mark' },
      cancellations: [],
      triggered: [],
    };
  }
}

function flatResult(): EngineSubmitResult {
  return {
    accepted: false,
    sequence: null,
    fills: [],
    resting: null,
    rejected: { code: 'position_flat', message: 'account is flat on this book; the engine does not invent a mark' },
    cancellations: [],
    triggered: [],
  };
}

describe('H8a money suite is not skip-green', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-trade close-position (H8a PG-hard)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql: TestDatabase['sql'];

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  describe('close-position through matching flatten', () => {
    let ledger: MemoryLedger;
    let matching: StubMatchingClose;
    let trade: TradeService;
    let btcusdt: Market;

    async function fund(userId: string, assetId: string, amount: string) {
      await ledger.post(
        recipes.deposit({
          userId,
          assetId,
          amount: amt(amount),
          rail: 'test',
          railRef: `${userId}:${assetId}:${amount}:${Math.random()}`,
        }),
      );
    }
    const avail = async (userId: string, assetId: string) => formatAmount((await ledger.balance(userAvailable(userId, assetId))).amount);
    const heldFor = async (userId: string, assetId: string, orderId: string) =>
      formatAmount((await ledger.balance(orderHoldAccount(userId, assetId, orderId))).amount);
    const postsWithReason = (reason: string) => ledger.journal().filter((tx) => tx.reason === reason);

    beforeEach(async () => {
      await sql`TRUNCATE trade.order_replace_requests, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
      ledger = new MemoryLedger();
      matching = new StubMatchingClose();
      trade = new TradeService(sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
        marketSlippageCapBps: 200,
      });
      btcusdt = await trade.listMarket({
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
    });

    it('refuses a flat book — no ledger post, no invented mark', async () => {
      matching.closeScript = () => flatResult();
      await expect(
        closeSpotPosition(trade, principalFor(ALICE), {
          marketId: btcusdt.id,
          clientOrderId: 'close-flat',
        }),
      ).rejects.toMatchObject({ code: 'trade.position_flat' });
      expect(matching.closed).toHaveLength(1);
      expect(matching.closed[0]?.request).not.toHaveProperty('qty');
      expect(matching.closed[0]?.request).not.toHaveProperty('price');
      expect(matching.closed[0]?.request).not.toHaveProperty('side');
      expect(postsWithReason('order.hold')).toHaveLength(0);
      expect(postsWithReason('order.hold.released')).toHaveLength(0);
      const rows = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.orders`;
      expect(rows[0]?.n).toBe('0');
    });

    it('flattens through matching close and settles the engine fill — no invented mark', async () => {
      await fund(BOB, 'USDT', '100');
      const maker = await trade.placeOrder(principalFor(BOB), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'bob-bid',
      });
      expect(maker.status).toBe('open');

      await fund(ALICE, 'BTC', '2');
      matching.closeScript = (_marketId, request) => ({
        accepted: true,
        sequence: 2,
        fills: [
          {
            sequence: 3,
            makerOrderId: maker.id,
            makerAccountId: BOB,
            takerOrderId: request.orderId,
            takerAccountId: ALICE,
            takerSide: 'sell',
            price: '100',
            qty: '1',
          },
        ],
        resting: null,
        rejected: null,
        cancellations: [],
        triggered: [],
      });

      const order = await closeSpotPosition(trade, principalFor(ALICE), {
        marketId: btcusdt.id,
        clientOrderId: 'close-long',
      });

      expect(matching.closed).toHaveLength(1);
      expect(matching.closed[0]?.marketId).toBe(btcusdt.id);
      expect(matching.closed[0]?.request.accountId).toBe(ALICE);
      expect(matching.closed[0]?.request).not.toHaveProperty('qty');
      expect(matching.closed[0]?.request).not.toHaveProperty('price');
      expect(order.status).toBe('filled');
      expect(order.side).toBe('sell');
      expect(formatAmount(order.qty)).toBe('1');
      expect(await heldFor(ALICE, 'BTC', order.id)).toBe('0');
    });

    it('releases leftover hold through recipes.orderHoldRelease', async () => {
      await fund(BOB, 'USDT', '100');
      const maker = await trade.placeOrder(principalFor(BOB), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'bob-bid-partial',
      });

      await fund(ALICE, 'BTC', '3');
      matching.closeScript = (_marketId, request) => ({
        accepted: true,
        sequence: 4,
        fills: [
          {
            sequence: 5,
            makerOrderId: maker.id,
            makerAccountId: BOB,
            takerOrderId: request.orderId,
            takerAccountId: ALICE,
            takerSide: 'sell',
            price: '100',
            qty: '1',
          },
        ],
        resting: null,
        rejected: null,
        cancellations: [
          {
            orderId: request.orderId,
            accountId: ALICE,
            remainingQty: '1',
            sequence: 6,
            reason: 'ioc_remainder',
          },
        ],
        triggered: [],
      });

      const order = await closeSpotPosition(trade, principalFor(ALICE), {
        marketId: btcusdt.id,
        clientOrderId: 'close-leftover',
      });

      expect(formatAmount(order.qty)).toBe('2');
      expect(await heldFor(ALICE, 'BTC', order.id)).toBe('0');
      expect(await avail(ALICE, 'BTC')).toBe('2');
      expect(postsWithReason('order.hold.released')).toHaveLength(1);
    });
  });
});
