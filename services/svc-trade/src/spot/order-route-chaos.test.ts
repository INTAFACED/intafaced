import { TradeService } from '../controls/test-admission.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes, userAvailable, orderHoldAccount } from '@intafaced/ledger-client';

import type { Market } from './types.js';
import { orderIdFor } from './ids.js';
import {
  CancelTimeoutMatching,
  DuplicateOrderIdMatching,
  READY_MARKET_LIFECYCLE,
  StubMatching,
  StubPerks,
  SubmitAcceptedThenDieMatching,
  SubmitUnknownThenAbsentMatching,
  principalFor,
  PUBLISHED_TEST_FEE_SCHEDULE,
} from './testing.js';
import type { MarketLifecyclePort } from '../market-lifecycle.js';

/**
 * Order-route chaos spine (Spec CX-7 · Plan P1-1 / P1-4 · Architect Seam B1).
 *
 * In-process: real TradeService + MemoryLedger + StubMatching. Steady state S:
 * ledger conserved, no double hold/fill/release, open orders reconcilable.
 *
 * Catalog coverage:
 *   F1 concurrent clientOrderId · F2 fill redelivery · F3 partial cancel
 *   F4 matching transport fail · F5 trade die after accept (H8c hold stays) · F6 matching restart
 *   F7 kill-switch · F8 seed public volume (order-route-seed.test.ts)
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
      `H8a: svc-trade order-route-chaos is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

describe('H8a money suite is not skip-green', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-trade order-route-chaos (H8a PG-hard)', () => {
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
  const held = async (userId: string, assetId: string) => {
    const all = await ledger.balances('user', userId);
    return formatAmount(
      all.filter((b) => b.account.kind === 'hold' && b.account.assetId === assetId).reduce((acc, b) => acc + b.amount, 0n),
    );
  };
  const heldFor = async (userId: string, assetId: string, orderId: string) =>
    formatAmount((await ledger.balance(orderHoldAccount(userId, assetId, orderId))).amount);
  const postsWithReason = (reason: string) => ledger.journal().filter((tx) => tx.reason === reason);

  async function rest(userId: string, market: Market, side: 'buy' | 'sell', qty: string, price: string, clientOrderId: string) {
    return trade.placeOrder(principalFor(userId), {
      marketId: market.id,
      side,
      type: 'limit',
      qty: amt(qty),
      price: amt(price),
      clientOrderId,
    });
  }

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

  describe('chaos F1 — concurrent same clientOrderId', () => {
    it('one order, one hold, one engine submit under concurrent place', async () => {
      await fund(ALICE, 'USDT', '2000');

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          rest(ALICE, btcusdt, 'buy', '2', '100', 'chaos-f1')
            .then((o) => o.id)
            .catch(() => 'failed'),
        ),
      );

      const ids = new Set(results.filter((r) => r !== 'failed'));
      expect(ids.size).toBe(1);
      expect(await sql`SELECT id FROM trade.orders`).toHaveLength(1);
      expect(postsWithReason('order.hold')).toHaveLength(1);
      expect(matching.submitted).toHaveLength(1);
      expect(await held(ALICE, 'USDT')).toBe('200');
      expect(await avail(ALICE, 'USDT')).toBe('1800');
      expect(ledger.totalsByAsset().USDT).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('same clientOrderId retry returns the unresolved original without resubmit or second hold', async () => {
      const submitUnknown = new SubmitUnknownThenAbsentMatching();
      const lifecycleCalls = { snapshot: 0, admit: 0 };
      const countedLifecycle: MarketLifecyclePort = {
        snapshot: (market, options) => {
          lifecycleCalls.snapshot += 1;
          return READY_MARKET_LIFECYCLE.snapshot(market, options);
        },
        admit: (snapshot, action) => {
          lifecycleCalls.admit += 1;
          return READY_MARKET_LIFECYCLE.admit(snapshot, action);
        },
      };
      const service = new TradeService(sql, ledger, submitUnknown, perks, bus, {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: countedLifecycle,
        spotEnabled: true,
      });
      await fund(ALICE, 'USDT', '1000');
      const input = {
        marketId: btcusdt.id,
        side: 'buy' as const,
        type: 'limit' as const,
        qty: amt('2'),
        price: amt('100'),
        clientOrderId: 'chaos-f4-retry',
      };

      await expect(service.placeOrder(principalFor(ALICE), input)).rejects.toThrow(/possible dispatch/);
      const original = await service.findOrder(orderIdFor(ALICE, btcusdt.id, input.clientOrderId));
      expect(original?.lifecycleProof).not.toBeNull();
      const retry = await service.placeOrder(principalFor(ALICE), input);
      expect(retry.status).toBe('recovery_required');
      expect(retry.recoveryReason).toBe('SUBMIT_UNKNOWN');
      expect(JSON.stringify(retry.lifecycleProof)).toBe(JSON.stringify(original?.lifecycleProof));
      expect(submitUnknown.submitted).toHaveLength(1);
      expect(lifecycleCalls).toEqual({ snapshot: 1, admit: 1 });
      expect(postsWithReason('order.hold')).toHaveLength(1);
      expect(await held(ALICE, 'USDT')).toBe('200');
    });

    it('cancel transport timeout becomes recovery-required without releasing the hold', async () => {
      await fund(ALICE, 'USDT', '1000');
      const open = await rest(ALICE, btcusdt, 'buy', '2', '100', 'chaos-f4-cancel-timeout');
      const cancelTimeout = new CancelTimeoutMatching();
      const recovery = new TradeService(sql, ledger, cancelTimeout, perks, bus, {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
      });

      await expect(recovery.cancelOrder(principalFor(ALICE), open.id)).rejects.toThrow(/cancel transport timed out/);
      const row = await recovery.findOrder(open.id);
      expect(row?.status).toBe('recovery_required');
      expect(row?.recoveryReason).toBe('CANCEL_UNKNOWN');
      expect(await heldFor(ALICE, 'USDT', open.id)).toBe('200');
      expect(postsWithReason('order.hold.released')).toHaveLength(0);
    });
  });

  describe('chaos F2 — fill redelivery', () => {
    it('redelivered fill settles once (idempotent on engine business key)', async () => {
      await fund(BOB, 'BTC', '5');
      await fund(ALICE, 'USDT', '1000');

      const maker = await rest(BOB, btcusdt, 'sell', '2', '100', 'bob-f2');
      matching.scriptFills([{ makerOrderId: maker.id, makerAccountId: BOB, price: '100', qty: '2' }]);
      const taker = await rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-f2');

      const sequence = (await sql<Array<{ sequence: number }>>`SELECT sequence FROM trade.fills LIMIT 1`)[0]!.sequence;

      // Ordinary bus redelivery path — settle again with the same sequence.
      for (let i = 0; i < 5; i++) {
        await trade.settleFillEvent({
          marketId: btcusdt.id,
          makerOrderId: maker.id,
          takerOrderId: taker.id,
          price: '100',
          qty: '2',
          sequence,
        });
      }

      expect(postsWithReason('trade.fill')).toHaveLength(1);
      expect(await sql`SELECT id FROM trade.fills`).toHaveLength(2);
      expect(await avail(ALICE, 'BTC')).toBe('1.996');
      expect(await held(ALICE, 'USDT')).toBe('0');
      expect(ledger.totalsByAsset()).toEqual({ BTC: '0', USDT: '0' });
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
  });

  describe('chaos F3 — partial cancel remainder once', () => {
    it('cancel after partial fill releases only remainder; redelivery releases nothing more', async () => {
      await fund(BOB, 'BTC', '10');
      await fund(ALICE, 'USDT', '2000');

      const maker = await rest(BOB, btcusdt, 'sell', '10', '100', 'bob-f3');
      matching.scriptFills([{ makerOrderId: maker.id, makerAccountId: BOB, price: '100', qty: '4' }], { restRemainder: '6' });
      const order = await rest(ALICE, btcusdt, 'buy', '10', '100', 'alice-f3');

      expect(order.status).toBe('open');
      expect(formatAmount(order.filledQty)).toBe('4');
      expect(await held(ALICE, 'USDT')).toBe('600');

      await trade.cancelOrder(principalFor(ALICE), order.id);
      // Redelivered cancel event (engine → bus → trade).
      await trade.releaseOnCancelEvent(order.id);
      await trade.releaseOnCancelEvent(order.id);

      expect(await avail(ALICE, 'USDT')).toBe('1600');
      expect(await held(ALICE, 'USDT')).toBe('0');
      expect(postsWithReason('order.hold.released')).toHaveLength(1);
      expect(ledger.totalsByAsset().USDT).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
  });

  describe('chaos F4 — matching transport fail after hold', () => {
    it('order stays open with hold; cancel recovers full funds', async () => {
      const submitUnknown = new SubmitUnknownThenAbsentMatching();
      const service = new TradeService(sql, ledger, submitUnknown, perks, bus, {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
      });
      await fund(ALICE, 'USDT', '1000');

      await expect(
        service.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('2'),
          price: amt('100'),
          clientOrderId: 'chaos-f4',
        }),
      ).rejects.toThrow(/unreachable/);

      const orderId = orderIdFor(ALICE, btcusdt.id, 'chaos-f4');
      const order = await service.findOrder(orderId);
      expect(order?.status).toBe('recovery_required');
      expect(order?.recoveryReason).toBe('SUBMIT_UNKNOWN');
      expect(order?.reconciliationKey).toBe(`trade.order.reconcile:${orderId}:SUBMIT_UNKNOWN`);
      expect(await heldFor(ALICE, 'USDT', orderId)).toBe('200');
      expect(await held(ALICE, 'USDT')).toBe('200');

      // Recovery: cancel. Engine answers not-live; hold comes back once.
      await service.cancelOrder(principalFor(ALICE), orderId);
      expect(await avail(ALICE, 'USDT')).toBe('1000');
      expect(await held(ALICE, 'USDT')).toBe('0');
      expect(postsWithReason('order.hold.released')).toHaveLength(1);
      expect(ledger.totalsByAsset().USDT).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
  });

  describe('chaos F5 — trade die after engine accept; consumer settles once', () => {
    it('recovery settleFillEvent after offline match settles once (no double settle)', async () => {
      // Both rest with no inline fills (engine "matched while trade was dead").
      await fund(BOB, 'BTC', '5');
      await fund(ALICE, 'USDT', '1000');
      const maker = await rest(BOB, btcusdt, 'sell', '2', '100', 'bob-f5');
      const taker = await rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-f5');
      expect(maker.status).toBe('open');
      expect(taker.status).toBe('open');

      const sequence = 77_001;
      for (let i = 0; i < 4; i++) {
        await trade.settleFillEvent({
          marketId: btcusdt.id,
          makerOrderId: maker.id,
          takerOrderId: taker.id,
          price: '100',
          qty: '2',
          sequence,
        });
      }

      expect(postsWithReason('trade.fill')).toHaveLength(1);
      expect(await held(ALICE, 'USDT')).toBe('0');
      expect(await held(BOB, 'BTC')).toBe('0');
      expect(ledger.totalsByAsset()).toEqual({ BTC: '0', USDT: '0' });
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('matching 200 then death before fill/ack: orderHold stays; retry does not double-hold', async () => {
      const dying = new SubmitAcceptedThenDieMatching();
      const service = new TradeService(sql, ledger, dying, perks, bus, {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
      });
      await fund(ALICE, 'USDT', '1000');
      const input = {
        marketId: btcusdt.id,
        side: 'buy' as const,
        type: 'limit' as const,
        qty: amt('2'),
        price: amt('100'),
        clientOrderId: 'chaos-h8c-die',
      };

      await expect(service.placeOrder(principalFor(ALICE), input)).rejects.toThrow(/matching 200 before fill\/ack/);

      const orderId = orderIdFor(ALICE, btcusdt.id, input.clientOrderId);
      expect(await heldFor(ALICE, 'USDT', orderId)).toBe('200');
      expect(postsWithReason('order.hold')).toHaveLength(1);
      expect(postsWithReason('order.hold.released')).toHaveLength(0);
      expect(dying.submitted).toHaveLength(1);
      expect(typeof dying.submitted[0]!.request.qty).toBe('string');
      expect(typeof dying.submitted[0]!.request.price).toBe('string');
      expect(dying.submitted[0]!.request.qty).toBe('2');
      expect(dying.submitted[0]!.request.price).toBe('100');
      const listed = await dying.listOrders(btcusdt.id);
      expect(listed.orders).toHaveLength(1);
      expect(listed.orders[0]!.remaining).toBe('2');
      expect(typeof listed.orders[0]!.remaining).toBe('string');

      const retry = await service.placeOrder(principalFor(ALICE), input);
      expect(retry.id).toBe(orderId);
      expect(retry.status).toBe('recovery_required');
      expect(retry.recoveryReason).toBe('SUBMIT_UNKNOWN');
      expect(dying.submitted).toHaveLength(1);
      expect(postsWithReason('order.hold')).toHaveLength(1);
      expect(postsWithReason('order.hold.released')).toHaveLength(0);
      expect(await heldFor(ALICE, 'USDT', orderId)).toBe('200');
      expect(await avail(ALICE, 'USDT')).toBe('800');
      expect(ledger.totalsByAsset().USDT).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('matching 200 retry duplicate_order_id does not release the hold', async () => {
      const dup = new DuplicateOrderIdMatching();
      const service = new TradeService(sql, ledger, dup, perks, bus, {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
      });
      await fund(ALICE, 'USDT', '1000');
      const input = {
        marketId: btcusdt.id,
        side: 'buy' as const,
        type: 'limit' as const,
        qty: amt('2'),
        price: amt('100'),
        clientOrderId: 'chaos-h8c-dup',
      };

      const order = await service.placeOrder(principalFor(ALICE), input);
      expect(order.status).toBe('open');
      expect(order.status).not.toBe('rejected');
      const orderId = order.id;
      expect(await heldFor(ALICE, 'USDT', orderId)).toBe('200');
      expect(postsWithReason('order.hold')).toHaveLength(1);
      expect(postsWithReason('order.hold.released')).toHaveLength(0);
      expect(dup.submitted).toHaveLength(1);
      expect(typeof dup.submitted[0]!.request.qty).toBe('string');
      expect(typeof dup.submitted[0]!.request.price).toBe('string');
      const listed = await dup.listOrders(btcusdt.id);
      expect(listed.orders).toHaveLength(1);
      expect(listed.orders[0]!.remaining).toBe('2');
      expect(typeof listed.orders[0]!.remaining).toBe('string');
      expect(typeof listed.orders[0]!.price).toBe('string');

      const retry = await service.placeOrder(principalFor(ALICE), input);
      expect(retry.id).toBe(orderId);
      expect(retry.status).toBe('open');
      expect(dup.submitted).toHaveLength(1);
      expect(postsWithReason('order.hold')).toHaveLength(1);
      expect(postsWithReason('order.hold.released')).toHaveLength(0);
      expect(await heldFor(ALICE, 'USDT', orderId)).toBe('200');
      expect(ledger.totalsByAsset().USDT).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
  });

  describe('chaos F6 — matching restart / journal replay no double settle', () => {
    it('after matching process restart, journal redelivery never double-settles or double-releases', async () => {
      await fund(BOB, 'BTC', '10');
      await fund(ALICE, 'USDT', '2000');
      const maker = await rest(BOB, btcusdt, 'sell', '10', '100', 'bob-f6');
      matching.scriptFills([{ makerOrderId: maker.id, makerAccountId: BOB, price: '100', qty: '4' }], { restRemainder: '6' });
      const partial = await rest(ALICE, btcusdt, 'buy', '10', '100', 'alice-f6');

      const sequence = (await sql<Array<{ sequence: number }>>`SELECT sequence FROM trade.fills LIMIT 1`)[0]!.sequence;

      // Process death: clear in-process book/scripts; sequence floor preserved.
      // Then journal re-emits fill + cancel events (consumer idempotency).
      matching.simulateProcessRestart();
      expect(matching.submitted).toHaveLength(0);

      for (let i = 0; i < 3; i++) {
        await trade.settleFillEvent({
          marketId: btcusdt.id,
          makerOrderId: maker.id,
          takerOrderId: partial.id,
          price: '100',
          qty: '4',
          sequence,
        });
      }
      await trade.cancelOrder(principalFor(ALICE), partial.id);
      await trade.releaseOnCancelEvent(partial.id);
      await trade.releaseOnCancelEvent(partial.id);

      expect(postsWithReason('trade.fill')).toHaveLength(1);
      expect(postsWithReason('order.hold.released')).toHaveLength(1);
      expect(ledger.totalsByAsset().USDT).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
  });

  describe('chaos F7 — kill-switch place refuse + cancel still ok', () => {
    it('spot kill-switch refuses new places; cancel of open order still releases hold', async () => {
      await fund(ALICE, 'USDT', '1000');
      const open = await rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-f7-open');
      expect(open.status).toBe('open');
      expect(await held(ALICE, 'USDT')).toBe('200');

      const killed = new TradeService(sql, ledger, matching, perks, bus, { feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE, spotEnabled: false });

      await expect(
        killed.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('1'),
          price: amt('100'),
          clientOrderId: 'alice-f7-blocked',
        }),
      ).rejects.toMatchObject({ code: 'trade.spot_disabled' });

      // Cancel still works — kill-switch must not trap funds.
      await killed.cancelOrder(principalFor(ALICE), open.id);
      expect(await avail(ALICE, 'USDT')).toBe('1000');
      expect(await held(ALICE, 'USDT')).toBe('0');
      expect(postsWithReason('order.hold.released')).toHaveLength(1);
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });
  });
});
