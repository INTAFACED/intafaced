import { TradeService } from '../controls/test-admission.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import {
  formatAmount,
  LedgerError,
  MemoryLedger,
  parseAmount as amt,
  recipes,
  userAvailable,
  orderHoldAccount,
  type LedgerClient,
} from '@intafaced/ledger-client';

import { CloseNotFundedError, closeSpotPosition, installClosePosition } from './close-position.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from './testing.js';
import type { EngineSubmitRequest } from './matching-client.js';
import { decideMarketAction, type MarketLifecyclePort } from '../market-lifecycle.js';
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

/** Matching as the close sees it: the signed net it reads, then the reduce-only order it is sent. */
class StubMatchingNet extends StubMatching {
  readonly net = new Map<string, string>();
  readonly netReads: Array<{ marketId: string; accountId: string }> = [];

  async netPosition(marketId: string, accountId: string) {
    this.netReads.push({ marketId, accountId });
    return amt(this.net.get(accountId) ?? '0');
  }
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

  describe('close-position: hold first, then a protected reduce-only order (#4591)', () => {
    let ledger: MemoryLedger;
    let matching: StubMatchingNet;
    let trade: TradeService;
    let btcusdt: Market;

    async function fund(userId: string, assetId: string, amount: string, into: { post: LedgerClient['post'] } = ledger) {
      await into.post(
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
    const rowsFor = (clientOrderId: string) =>
      sql<Array<{ id: string; status: string; type: string; price: string | null; qty: string; protection_price: string | null }>>`
        SELECT id, status::text, type::text, price::text, qty::text, protection_price::text
          FROM trade.orders WHERE client_order_id = ${clientOrderId}`;

    function service(over: { ledger?: LedgerClient; lifecycle?: MarketLifecyclePort; capBps?: number | null } = {}) {
      return new TradeService(sql, over.ledger ?? ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: over.lifecycle ?? READY_MARKET_LIFECYCLE,
        spotEnabled: true,
        ...(over.capBps === null ? {} : { marketSlippageCapBps: over.capBps ?? 200 }),
      });
    }

    /** What the engine was sent for one close, and the close's own hold at that moment. */
    function watchSubmit(assetId: string) {
      const seen: Array<{ request: EngineSubmitRequest; heldAtSubmit: string }> = [];
      matching.onSubmit = async (request) => {
        seen.push({ request, heldAtSubmit: await heldFor(ALICE, assetId, request.orderId) });
      };
      return seen;
    }

    beforeEach(async () => {
      await sql`TRUNCATE trade.order_replace_requests, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
      ledger = new MemoryLedger();
      matching = new StubMatchingNet();
      trade = service();
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

    it('refuses when the owner protection floor is unpublished, before reading the position or sending anything', async () => {
      matching.net.set(ALICE, '1');
      await expect(
        closeSpotPosition(service({ capBps: null }), principalFor(ALICE), { marketId: btcusdt.id, clientOrderId: 'close-unset' }),
      ).rejects.toMatchObject({ code: 'trade.protection_unset' });
      expect(matching.netReads).toHaveLength(0);
      expect(matching.submitted).toHaveLength(0);
      expect(postsWithReason('order.hold')).toHaveLength(0);
    });

    it('refuses a flat book: no row, no ledger post, nothing sent to the engine', async () => {
      await expect(
        closeSpotPosition(trade, principalFor(ALICE), { marketId: btcusdt.id, clientOrderId: 'close-flat' }),
      ).rejects.toMatchObject({
        code: 'trade.position_flat',
      });
      expect(matching.netReads).toEqual([{ marketId: btcusdt.id, accountId: ALICE }]);
      expect(matching.submitted).toHaveLength(0);
      expect(postsWithReason('order.hold')).toHaveLength(0);
      expect(await sql`SELECT 1 FROM trade.orders`).toHaveLength(0);
    });

    it('closes a long: holds the base before the engine, sends a reduce-only sell floored at the cap, settles the fill', async () => {
      await fund(BOB, 'USDT', '100');
      const maker = await trade.placeOrder(principalFor(BOB), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'bob-bid',
      });
      await fund(ALICE, 'BTC', '2');
      matching.net.set(ALICE, '1');
      matching.bids = [['100', '1']];
      matching.scriptFills([{ makerOrderId: maker.id, makerAccountId: BOB, price: '100', qty: '1' }]);
      const seen = watchSubmit('BTC');

      const order = await closeSpotPosition(trade, principalFor(ALICE), { marketId: btcusdt.id, clientOrderId: 'close-long' });

      // Funded before the engine saw it: the whole 1 BTC was held when the order was sent.
      expect(seen).toHaveLength(1);
      expect(seen[0]!.heldAtSubmit).toBe('1');
      // The engine got a reduce-only IOC sell for the exact net, priced no lower than bid - 2% (#4591 c).
      expect(seen[0]!.request).toMatchObject({ side: 'sell', qty: '1', type: 'limit', tif: 'IOC', price: '98', reduceOnly: true });
      expect(order).toMatchObject({ side: 'sell', type: 'market', status: 'filled', price: null });
      expect(formatAmount(order.qty)).toBe('1');
      expect(await heldFor(ALICE, 'BTC', order.id)).toBe('0');
      expect(await avail(ALICE, 'BTC')).toBe('1');
      // A market row stores no price (orders_price_shape_ck); the executed price lives on the fill.
      const row = (await rowsFor('close-long'))[0]!;
      expect(row).toMatchObject({ type: 'market', price: null });
      expect(Number(row.protection_price)).toBe(98);
      expect(
        (await sql<Array<{ price: string }>>`SELECT price::text FROM trade.fills WHERE order_id = ${order.id}`).map((f) => Number(f.price)),
      ).toEqual([100]);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it("keeps the order's own qty and releases the leftover hold, whatever else the engine cancelled (#4591 b)", async () => {
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
      matching.net.set(ALICE, '2');
      matching.bids = [['100', '1']];
      matching.script1((request, next) => ({
        accepted: true,
        sequence: next(),
        fills: [
          {
            sequence: next(),
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
          // A self-trade-prevention pull of some other order: it used to be summed into the close's qty.
          { orderId: '99999999-9999-4999-8999-999999999999', accountId: ALICE, remainingQty: '5', sequence: next(), reason: 'stp' },
          { orderId: request.orderId, accountId: ALICE, remainingQty: '1', sequence: next(), reason: 'ioc_remainder' },
        ],
        triggered: [],
      }));

      const order = await closeSpotPosition(trade, principalFor(ALICE), { marketId: btcusdt.id, clientOrderId: 'close-leftover' });

      expect(formatAmount(order.qty)).toBe('2');
      expect(formatAmount(order.filledQty)).toBe('1');
      expect(Number((await rowsFor('close-leftover'))[0]!.qty)).toBe(2);
      expect(await heldFor(ALICE, 'BTC', order.id)).toBe('0');
      expect(await avail(ALICE, 'BTC')).toBe('2');
      expect(postsWithReason('order.hold.released')).toHaveLength(1);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('closes a short: holds protection x qty in quote before the engine, caps the buy, settles every level and releases the rest', async () => {
      await fund(BOB, 'BTC', '2');
      const ask1 = await trade.placeOrder(principalFor(BOB), {
        marketId: btcusdt.id,
        side: 'sell',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'bob-ask-1',
      });
      const ask2 = await trade.placeOrder(principalFor(BOB), {
        marketId: btcusdt.id,
        side: 'sell',
        type: 'limit',
        qty: amt('1'),
        price: amt('101'),
        clientOrderId: 'bob-ask-2',
      });
      await fund(ALICE, 'USDT', '1000');
      matching.net.set(ALICE, '-2');
      matching.asks = [['100', '1']];
      matching.scriptFills([
        { makerOrderId: ask1.id, makerAccountId: BOB, price: '100', qty: '1' },
        { makerOrderId: ask2.id, makerAccountId: BOB, price: '101', qty: '1' },
      ]);
      const seen = watchSubmit('USDT');

      const order = await closeSpotPosition(trade, principalFor(ALICE), { marketId: btcusdt.id, clientOrderId: 'close-short' });

      // Best ask 100 + 2% = 102: the engine may not fill above it, and 102 x 2 was held before it was asked.
      expect(seen[0]!.request).toMatchObject({ side: 'buy', qty: '2', type: 'limit', tif: 'IOC', price: '102', reduceOnly: true });
      expect(seen[0]!.heldAtSubmit).toBe('204');
      expect(order).toMatchObject({ side: 'buy', status: 'filled', type: 'market', price: null });
      expect(formatAmount(order.filledQty)).toBe('2');
      const fills = await sql<Array<{ price: string }>>`SELECT price::text FROM trade.fills WHERE order_id = ${order.id} ORDER BY price`;
      expect(fills.map((f) => Number(f.price))).toEqual([100, 101]);
      // Both fills settled (100 + 101); the 3 left of the hold went back.
      expect(await avail(ALICE, 'USDT')).toBe('799');
      expect(await heldFor(ALICE, 'USDT', order.id)).toBe('0');
      expect(await avail(ALICE, 'BTC')).not.toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('a BUY close the account cannot fund is refused before the engine: no fill, no row, nothing held (#4591 a)', async () => {
      await fund(ALICE, 'USDT', '50');
      matching.net.set(ALICE, '-1');
      matching.asks = [['100', '1']];

      const err = await closeSpotPosition(trade, principalFor(ALICE), { marketId: btcusdt.id, clientOrderId: 'close-poor' }).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(CloseNotFundedError);
      expect(matching.submitted).toHaveLength(0);
      expect(await rowsFor('close-poor')).toEqual([]);
      expect(await avail(ALICE, 'USDT')).toBe('50');
      expect(ledger.journal().filter((tx) => tx.reason === 'order.hold')).toHaveLength(0);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('a hold the ledger refuses by name sends nothing and leaves no row', async () => {
      const inner = new MemoryLedger();
      const client: LedgerClient = {
        post: async (req) => {
          if (req.reason === 'order.hold') throw new LedgerError('insufficient funds', 'ledger.insufficient_funds');
          return inner.post(req);
        },
        balance: (ref) => inner.balance(ref),
        balances: (ownerType, ownerId) => inner.balances(ownerType, ownerId),
        getTx: (id) => inner.getTx(id),
        getTxByKey: (key) => inner.getTxByKey(key),
      };
      await fund(ALICE, 'BTC', '2', inner);
      matching.net.set(ALICE, '1');
      matching.bids = [['100', '1']];

      const err = await closeSpotPosition(service({ ledger: client }), principalFor(ALICE), {
        marketId: btcusdt.id,
        clientOrderId: 'close-refused',
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(CloseNotFundedError);
      expect((err as CloseNotFundedError).ledger.code).toBe('ledger.insufficient_funds');
      expect(matching.submitted).toHaveLength(0);
      expect(await rowsFor('close-refused')).toEqual([]);
    });

    it('a hold reply lost after booking keeps the row and the hold, sends nothing, and the retry finishes the close once', async () => {
      const inner = new MemoryLedger();
      let armed = false;
      const client: LedgerClient = {
        post: async (req) => {
          if (armed && req.reason === 'order.hold') {
            await inner.post(req);
            throw Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' });
          }
          return inner.post(req);
        },
        balance: (ref) => inner.balance(ref),
        balances: (ownerType, ownerId) => inner.balances(ownerType, ownerId),
        getTx: (id) => inner.getTx(id),
        getTxByKey: (key) => {
          if (armed) throw Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' });
          return inner.getTxByKey(key);
        },
      };
      const local = service({ ledger: client });
      await fund(BOB, 'USDT', '100', inner);
      const maker = await local.placeOrder(principalFor(BOB), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'bob-close-lost',
      });
      await fund(ALICE, 'BTC', '2', inner);
      matching.net.set(ALICE, '1');
      matching.bids = [['100', '1']];
      matching.scriptFills([{ makerOrderId: maker.id, makerAccountId: BOB, price: '100', qty: '1' }]);
      const before = matching.submitted.length;
      armed = true;

      await expect(
        closeSpotPosition(local, principalFor(ALICE), { marketId: btcusdt.id, clientOrderId: 'close-lost' }),
      ).rejects.toMatchObject({
        code: 'trade.hold_unknown',
      });
      const rows = await rowsFor('close-lost');
      expect(rows.map((r) => r.status)).toEqual(['hold_unknown']);
      expect(formatAmount((await inner.balance(orderHoldAccount(ALICE, 'BTC', rows[0]!.id))).amount)).toBe('1');
      // Nothing reached the engine while the hold was unknown.
      expect(matching.submitted.length).toBe(before);

      armed = false;
      const order = await closeSpotPosition(local, principalFor(ALICE), { marketId: btcusdt.id, clientOrderId: 'close-lost' });
      expect(order.id).toBe(rows[0]!.id);
      expect(order.status).toBe('filled');
      expect(matching.submitted.slice(before).map((c) => c.request.orderId)).toEqual([order.id]);
      expect(inner.journal().filter((tx) => tx.idempotencyKey === `order.hold:${order.id}`)).toHaveLength(1);
      expect(inner.reconcile()).toEqual({ ok: true });
    });

    it('a retry of a finished close returns the same row and never sends a second order', async () => {
      await fund(BOB, 'USDT', '100');
      const maker = await trade.placeOrder(principalFor(BOB), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'bob-bid-retry',
      });
      await fund(ALICE, 'BTC', '1');
      matching.net.set(ALICE, '1');
      matching.bids = [['100', '1']];
      matching.scriptFills([{ makerOrderId: maker.id, makerAccountId: BOB, price: '100', qty: '1' }]);
      const first = await closeSpotPosition(trade, principalFor(ALICE), { marketId: btcusdt.id, clientOrderId: 'close-retry' });
      const sent = matching.submitted.length;

      matching.net.set(ALICE, '0');
      const again = await closeSpotPosition(trade, principalFor(ALICE), { marketId: btcusdt.id, clientOrderId: 'close-retry' });

      expect(again.id).toBe(first.id);
      expect(again.status).toBe('filled');
      expect(matching.submitted.length).toBe(sent);
      expect(postsWithReason('order.hold').filter((tx) => tx.idempotencyKey === `order.hold:${first.id}`)).toHaveLength(1);
    });

    it('a position that shrank before the engine is refused by its reduce-only check, and the hold is released', async () => {
      await fund(ALICE, 'BTC', '2');
      matching.net.set(ALICE, '2');
      matching.bids = [['100', '1']];
      matching.script1(() => ({
        accepted: false,
        sequence: null,
        fills: [],
        resting: null,
        rejected: { code: 'would_increase_position', message: 'reduce-only refuses a qty that would increase the position' },
        cancellations: [],
        triggered: [],
      }));

      const order = await closeSpotPosition(trade, principalFor(ALICE), { marketId: btcusdt.id, clientOrderId: 'close-moved' });

      expect(order.status).toBe('rejected');
      expect(await heldFor(ALICE, 'BTC', order.id)).toBe('0');
      expect(await avail(ALICE, 'BTC')).toBe('2');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('a limit-only market still takes a close (CLOSE stays allowed), while a plain market order is refused', async () => {
      const limitOnly: MarketLifecyclePort = {
        snapshot: (market, options) => ({ ...READY_MARKET_LIFECYCLE.snapshot(market, options), state: 'LIMIT_ONLY' }) as never,
        admit: (snapshot, action) => decideMarketAction(snapshot, action),
      };
      const local = service({ lifecycle: limitOnly });
      await fund(ALICE, 'BTC', '2');
      matching.bids = [['100', '1']];

      await expect(
        local.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'sell',
          type: 'market',
          qty: amt('1'),
          clientOrderId: 'plain-mkt',
        }),
      ).rejects.toMatchObject({ code: 'trade.mode_limit_only' });

      matching.net.set(ALICE, '1');
      matching.scriptFills([], { cancelRemainder: '1' });
      const order = await closeSpotPosition(local, principalFor(ALICE), { marketId: btcusdt.id, clientOrderId: 'close-limit-only' });
      expect(order.side).toBe('sell');
      expect(matching.submitted.at(-1)!.request).toMatchObject({ orderId: order.id, reduceOnly: true, type: 'limit', price: '98' });
      expect(await heldFor(ALICE, 'BTC', order.id)).toBe('0');
      expect(await avail(ALICE, 'BTC')).toBe('2');
    });
  });
});
