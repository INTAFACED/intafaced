import { TradeService } from '../controls/test-admission.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes, userAvailable, orderHoldAccount } from '@intafaced/ledger-client';
import { fillsProveNoFill } from './trade-service.js';
import type { Market } from './types.js';
import { orderIdFor } from './ids.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from './testing.js';

/**
 * CX-9 reconcile — Plan P1-5.
 *
 * Three Spec cases: orphan pending · open+hold no engine · open+engine no hold (fail closed).
 */

/**
 * A PER-RUN DATABASE, created and dropped by this suite.
 *
 * trade's SQL is schema-qualified (`trade.…`) on purpose — §2 keeps a service
 * physically unable to reach outside its own schema. That is exactly why
 * `createTestDb`'s generated schema (`test_trade_4711_1`) cannot host it, and
 * why this suite used to share the one real `trade` schema in `intafaced_test`
 * with every other worktree on the machine — truncating their rows mid-test.
 *
 * `createTestDatabase` moves the isolation boundary from the schema to the
 * DATABASE and creates the schema under its real name inside it. Every
 * statement below, and every migration, is unchanged.
 *
 * The URL is the ADMIN one (`TEST_DATABASE_URL`), not `TEST_DATABASE_URL_TRADE`: creating a
 * database needs CREATEDB, which the per-service roles deliberately lack. It
 * must still name a `*_test` database — `assertTestDatabase` refuses anything
 * else, and asks the server rather than trusting the string.
 */
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
      `H8a: svc-trade order-route-reconcile is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

const ALICE = '11111111-1111-4111-8111-111111111111';

describe('H8a money suite is not skip-green', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('fillsProveNoFill — trade.fills evidence for engine-miss', () => {
  it('empty fills and filled_qty 0 is proven empty', () => {
    expect(fillsProveNoFill(0n, { count: 0, qty: 0n })).toBe(true);
  });

  it('any fill row or filled_qty is not proof of no fill', () => {
    expect(fillsProveNoFill(0n, { count: 1, qty: 0n })).toBe(false);
    expect(fillsProveNoFill(0n, { count: 1, qty: 1n })).toBe(false);
    expect(fillsProveNoFill(1n, { count: 0, qty: 0n })).toBe(false);
  });
});

describe('svc-trade order-route-reconcile (H8a PG-hard)', () => {
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

  let ledger: MemoryLedger;
  let bus: MemoryEventBus;
  let matching: StubMatching;
  let perks: StubPerks;
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

  beforeEach(async () => {
    await sql`TRUNCATE trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    bus = new MemoryEventBus('svc-trade');
    matching = new StubMatching();
    perks = new StubPerks();
    trade = new TradeService(sql, ledger, matching, perks, bus, {
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

  /**
   * 30s, not vitest's default 10s. Dropping a DATABASE is heavier than closing a
   * pool, and when several suite files tear down at the same moment Postgres
   * serialises the drops. The work still finishes well inside this; the default
   * was sized for `sql.end()`, which is all this hook used to do.
   */

  describe('CX-9 reconcile — orphan pending', () => {
    it('deletes a pending row with no hold (never funded)', async () => {
      const orderId = orderIdFor(ALICE, btcusdt.id, 'orphan-pending');
      await sql`
        INSERT INTO trade.orders (
          id, user_id, market_id, client_order_id, side, type, price, qty, status, tif,
          hold_asset, hold_amount, fee_discount_bps
        ) VALUES (
          ${orderId}, ${ALICE}, ${btcusdt.id}, 'orphan-pending', 'buy', 'limit',
          ${'100'}::numeric, ${'2'}::numeric, 'pending', 'GTC',
          'USDT', ${'200'}::numeric, 0
        )
      `;

      const result = await trade.reconcileOrder(orderId);
      expect(result.case).toBe('orphan_pending');
      expect(result.action).toBe('deleted');
      expect(result.holdBefore).toBe('0');
      expect(await trade.findOrder(orderId)).toBeNull();
      expect(ledger.journal().filter((tx) => tx.reason === 'order.hold')).toHaveLength(0);
    });
  });

  describe('CX-9 reconcile — open+hold no engine', () => {
    it('releases remainder once when engine misses and trade.fills prove empty', async () => {
      await fund(ALICE, 'USDT', '1000');
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('2'),
        price: amt('100'),
        clientOrderId: 'open-hold-no-engine',
      });
      expect(order.status).toBe('open');
      expect(await heldFor(ALICE, 'USDT', order.id)).toBe('200');

      matching.scriptCancelMiss(order.id);
      const result = await trade.reconcileOrder(order.id);

      expect(result.case).toBe('open_hold_no_engine');
      expect(result.action).toBe('released');
      expect(result.engineLive).toBe(false);
      // List miss → cancel must not run (non-destructive probe).
      expect(matching.cancelledOrders).toEqual([]);
      expect(matching.listedMarkets).toContain(btcusdt.id);
      expect(await heldFor(ALICE, 'USDT', order.id)).toBe('0');
      expect(await avail(ALICE, 'USDT')).toBe('1000');
      const closed = await trade.findOrder(order.id);
      expect(closed?.status).toBe('cancelled');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('does not release when engine misses and trade.fills do not prove no fill', async () => {
      await fund(ALICE, 'USDT', '1000');
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('2'),
        price: amt('100'),
        clientOrderId: 'open-hold-unknown-fills',
      });
      expect(await heldFor(ALICE, 'USDT', order.id)).toBe('200');

      const counterId = '22222222-2222-4222-8222-222222222222';
      const fillId = '33333333-3333-4333-8333-333333333333';
      await sql`
        INSERT INTO trade.fills (
          id, order_id, counter_order_id, market_id, user_id, side, liquidity,
          price, qty, quote_amount, fee_asset, fee_amount, fee_bps, sequence
        ) VALUES (
          ${fillId}, ${order.id}, ${counterId}, ${btcusdt.id}, ${ALICE}, 'buy', 'taker',
          ${'100'}::numeric, ${'0.5'}::numeric, ${'50'}::numeric, 'USDT', ${'0'}::numeric, 0, 1
        )
      `;

      matching.scriptCancelMiss(order.id);
      const journalBefore = ledger.journal().length;
      const result = await trade.reconcileOrder(order.id);

      expect(result.case).toBe('open_hold_no_engine_unknown');
      expect(result.action).toBe('fail_closed');
      expect(result.engineLive).toBe(false);
      expect(result.detail).toContain('trade.reconcile_unknown_engine_miss');
      expect(matching.cancelledOrders).toEqual([]);
      expect(await heldFor(ALICE, 'USDT', order.id)).toBe('200');
      expect(await avail(ALICE, 'USDT')).toBe('800');
      expect((await trade.findOrder(order.id))?.status).toBe('open');
      expect(ledger.journal().length).toBe(journalBefore);
      expect(ledger.journal().filter((tx) => tx.reason === 'order.hold.released')).toHaveLength(0);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('lists before cancel when engine is live (open+hold)', async () => {
      await fund(ALICE, 'USDT', '1000');
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('2'),
        price: amt('100'),
        clientOrderId: 'open-hold-engine-live',
      });
      // placeOrder seeds liveById; list must fire before cancel.
      matching.listedMarkets.length = 0;
      matching.cancelledOrders.length = 0;

      const result = await trade.reconcileOrder(order.id);

      expect(result.case).toBe('open_hold_engine_cleared');
      expect(result.engineLive).toBe(true);
      expect(matching.listedMarkets[0]).toBe(btcusdt.id);
      expect(matching.cancelledOrders).toEqual([order.id]);
      expect(await heldFor(ALICE, 'USDT', order.id)).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
  });

  describe('CX-9 reconcile — open+engine no hold (fail closed)', () => {
    it('never invents a hold; terminalizes and reports fail_closed', async () => {
      await fund(ALICE, 'USDT', '1000');
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('2'),
        price: amt('100'),
        clientOrderId: 'open-engine-no-hold',
      });
      expect(await heldFor(ALICE, 'USDT', order.id)).toBe('200');

      // Simulate hold drained without a terminal order status (the forbidden dual-state).
      await ledger.post(
        recipes.orderHoldRelease({
          orderId: order.id,
          userId: ALICE,
          assetId: 'USDT',
          amount: amt('200'),
          sequence: 0,
        }),
      );
      expect(await heldFor(ALICE, 'USDT', order.id)).toBe('0');
      expect((await trade.findOrder(order.id))?.status).toBe('open');

      // Engine still considers the order live (default stub cancel → cancelled true).
      const result = await trade.reconcileOrder(order.id);

      expect(result.case).toBe('open_engine_no_hold');
      expect(result.action).toBe('fail_closed');
      expect(result.engineLive).toBe(true);
      expect(result.holdBefore).toBe('0');
      // No second hold invented — available stays whole after the manual release.
      expect(await avail(ALICE, 'USDT')).toBe('1000');
      expect(await heldFor(ALICE, 'USDT', order.id)).toBe('0');
      expect((await trade.findOrder(order.id))?.status).toBe('cancelled');
      // Only one order.hold and one order.hold.released for this order.
      expect(ledger.journal().filter((tx) => tx.reason === 'order.hold')).toHaveLength(1);
      expect(ledger.journal().filter((tx) => tx.reason === 'order.hold.released')).toHaveLength(1);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
  });
});
