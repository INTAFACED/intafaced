import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { AuthError } from '@intafaced/auth';
import {
  InsufficientFundsError,
  MemoryLedger,
  formatAmount,
  houseFees,
  marketMaker,
  marketMakerOrderHoldAccount,
  parseAmount as amt,
  recipes,
  userAvailable,
  orderHoldAccount,
} from '@intafaced/ledger-client';
import { TradeService } from './trade-service.js';
import { TradeError, type Market } from './types.js';
import { HOUSE_MM_USER_UUID, mmSeedOrderIdFor, orderIdFor } from './ids.js';
import { MM_MATCHING_ACCOUNT_ID } from '../mm/seed-market.js';
import { looksLikeAnonymousCustomerFill, recoverMatchingAccountId } from '../mm/fill-account.js';
import {
  PUBLISHED_TEST_FEE_SCHEDULE,
  READY_MARKET_LIFECYCLE,
  StubMatching,
  StubPerks,
  StubSubAccounts,
  UnreachableMatching,
  principalFor,
  restsInFull,
} from './testing.js';
import { parseFeeScheduleJson, UNPUBLISHED_FEE_SCHEDULE } from './fee-schedule.js';
import { decideMarketAction, type MarketLifecyclePort } from '../market-lifecycle.js';

/**
 * svc-trade money paths (§5.2).
 *
 * The ledger here is `MemoryLedger` — the reference implementation, which the
 * conformance suite proves behaves identically to svc-ledger's Postgres engine
 * (§4.4). That equivalence is what makes it legitimate: these tests are about
 * svc-trade's ORDERING, not about the ledger.
 *
 * Postgres is real, because the order row / ledger interaction is exactly where
 * a bug would hide — and because the release amount is derived from the fills
 * table, so "what does the database actually contain" is load-bearing.
 *
 * The matching engine is a stub (`./testing.ts` explains why). What is under
 * test is that funds are held before submission, that a fill draws the hold
 * down, that a cancel releases the remainder and only the remainder, and that
 * every one of those is idempotent.
 */

/**
 * A PER-RUN DATABASE, created and dropped by this suite.
 *
 * This test applies every forward migration, which means it MUTATES THE SCHEMA
 * of whatever it points at. Pointed at the shared `intafaced` database it
 * applied an unmerged branch's migration there, and `main`'s own svc-trade
 * tests began failing on a branch that had never touched them. A test that
 * changes shared state is not a test, it is a deployment. #211 moved it to
 * `intafaced_test`, which fixed that and left the smaller version of it:
 * `intafaced_test` is shared across worktrees too, so two agents running THIS
 * FILE still truncated each other's `trade.orders` mid-test.
 *
 * trade's SQL is schema-qualified (`trade.…`) on purpose — §2 keeps a service
 * physically unable to reach outside its own schema. That is exactly why
 * `createTestDb`'s generated schema (`test_trade_4711_1`) cannot host it, the
 * way it hosts svc-ledger. `createTestDatabase` moves the isolation boundary
 * from the schema to the DATABASE and creates `trade` under its real name
 * inside it. Every statement below, and every migration, is unchanged.
 *
 * The URL is the ADMIN one (`TEST_DATABASE_URL`), not `TEST_DATABASE_URL_TRADE`:
 * creating a database needs CREATEDB, which the per-service roles deliberately
 * lack. It must still name a `*_test` database — `assertTestDatabase` refuses
 * anything else, and asks the server rather than trusting the string.
 */
const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));

/**
 * EVERY forward migration, in order — not a hardcoded `0000_trade_init.sql`.
 *
 * The hardcoded form meant the test schema silently froze at the first
 * migration: adding `asset_class` and `schedule` left production with the
 * columns and the tests without them, and the failure arrived as
 * `column "asset_class" does not exist` from inside a service that was correct.
 * Reading the directory means a new migration is exercised the moment it lands.
 */
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAROL = '33333333-3333-4333-8333-333333333333';

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('svc-trade (Postgres unavailable — start docker compose)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'trade', url: URL, migrations });
  const sql = db.sql;

  let ledger: MemoryLedger;
  let bus: MemoryEventBus;
  let matching: StubMatching;
  let perks: StubPerks;
  let trade: TradeService;
  let btcusdt: Market;
  /** A second market with fat fees, so a rank discount is visible in integer bps. */
  let ethusdt: Market;

  /** Put real value in a user's available balance, the way a deposit would. */
  async function fund(userId: string, assetId: string, amount: string) {
    await ledger.post(
      recipes.deposit({ userId, assetId, amount: amt(amount), rail: 'test', railRef: `${userId}:${assetId}:${amount}:${Math.random()}` }),
    );
  }

  const avail = async (userId: string, assetId: string) => formatAmount((await ledger.balance(userAvailable(userId, assetId))).amount);
  /**
   * Everything held for a user in an asset, summed across purposes (P0-3).
   *
   * Holds are per-order now, so "how much is held" is a sum rather than one
   * account. Every assertion below keeps its original meaning and gains reach:
   * a stray hold under any other purpose would now show up here.
   */
  const held = async (userId: string, assetId: string) => {
    const all = await ledger.balances('user', userId);
    return formatAmount(
      all.filter((b) => b.account.kind === 'hold' && b.account.assetId === assetId).reduce((acc, b) => acc + b.amount, 0n),
    );
  };
  /** The hold belonging to one specific order. */
  const heldFor = async (userId: string, assetId: string, orderId: string) =>
    formatAmount((await ledger.balance(orderHoldAccount(userId, assetId, orderId))).amount);
  const fees = async (assetId: string) => formatAmount((await ledger.balance(houseFees('trade', assetId))).amount);

  const postsWithReason = (reason: string) => ledger.journal().filter((tx) => tx.reason === reason);

  /** Rest a maker order for `userId` and return its id. */
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
    await sql`TRUNCATE trade.convert_quotes, trade.order_replace_requests, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    bus = new MemoryEventBus('svc-trade');
    matching = new StubMatching();
    perks = new StubPerks();
    trade = new TradeService(sql, ledger, matching, perks, bus, {
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 150,
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
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

    ethusdt = await trade.listMarket({
      symbol: 'ETH/USDT',
      baseAsset: 'ETH',
      quoteAsset: 'USDT',
      tickSize: amt('0.01'),
      lotSize: amt('0.001'),
      minQty: amt('0.001'),
      maxQty: null,
      minNotional: amt('1'),
      makerBps: 100,
      takerBps: 200,
    });
  });

  /**
   * 30s, not vitest's default 10s. Dropping a DATABASE is heavier than closing a
   * pool, and when several suite files tear down at the same moment Postgres
   * serialises the drops. The work still finishes well inside this; the default
   * was sized for `sql.end()`, which is all this hook used to do.
   */
  afterAll(async () => {
    await db.drop();
  }, 30_000);

  // ── The happy path ────────────────────────────────────────────────────────


  describe('market orders', () => {
    it('funds a market buy at a protection price and releases what it did not spend', async () => {
      await fund(BOB, 'BTC', '5');
      await fund(ALICE, 'USDT', '1000');
      matching.asks = [['100', '5']];

      const maker = await rest(BOB, btcusdt, 'sell', '2', '100', 'bob-1');
      matching.scriptFills([{ makerOrderId: maker.id, makerAccountId: BOB, price: '100', qty: '2' }]);

      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'market',
        qty: amt('2'),
        clientOrderId: 'alice-mkt',
      });

      // Funded at 100 + 2% = 102 -> 204 held; only 200 was spent, and the
      // difference comes straight back rather than sitting in `hold` forever.
      expect(formatAmount(order.holdAmount)).toBe('204');
      expect(order.status).toBe('filled');
      expect(await avail(ALICE, 'USDT')).toBe('800');
      expect(await held(ALICE, 'USDT')).toBe('0');
      expect(await avail(ALICE, 'BTC')).toBe('1.996');
      expect(ledger.totalsByAsset()).toEqual({ BTC: '0', USDT: '0' });
    });

    it('submits a market buy to the engine as a marketable IOC limit at the protection price', async () => {
      await fund(ALICE, 'USDT', '1000');
      matching.asks = [['100', '5']];

      await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'market',
        qty: amt('2'),
        clientOrderId: 'alice-mkt',
      });

      // The engine therefore CANNOT fill it above what was held. That is the
      // whole reason the mapping exists.
      expect(matching.submitted[0]!.request).toMatchObject({ type: 'limit', price: '102', tif: 'IOC' });
    });

    it('submits a market sell as a market order — base is held exactly', async () => {
      await fund(BOB, 'BTC', '5');

      await trade.placeOrder(principalFor(BOB), {
        marketId: btcusdt.id,
        side: 'sell',
        type: 'market',
        qty: amt('2'),
        clientOrderId: 'bob-mkt',
      });

      expect(matching.submitted[0]!.request).toMatchObject({ type: 'market', price: null, tif: 'IOC' });
      expect(await held(BOB, 'BTC')).toBe('2');
    });

    it('refuses a market buy when the slippage cap is unset — never invents 200', async () => {
      await fund(ALICE, 'USDT', '1000');
      matching.asks = [['100', '5']];
      const unset = new TradeService(sql, ledger, matching, perks, bus, {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
      });
      await expect(
        unset.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'market',
          qty: amt('2'),
          clientOrderId: 'alice-mkt-cap-unset',
        }),
      ).rejects.toMatchObject({ code: 'trade.slippage_cap_unset' });
      expect(matching.submitted).toHaveLength(0);
      expect(await held(ALICE, 'USDT')).toBe('0');
    });

    it('still places a market sell when the slippage cap is unset — sell holds base qty', async () => {
      await fund(BOB, 'BTC', '5');
      const unset = new TradeService(sql, ledger, matching, perks, bus, {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
      });
      await unset.placeOrder(principalFor(BOB), {
        marketId: btcusdt.id,
        side: 'sell',
        type: 'market',
        qty: amt('2'),
        clientOrderId: 'bob-mkt-cap-unset',
      });
      expect(matching.submitted[0]!.request).toMatchObject({ type: 'market', price: null, tif: 'IOC' });
      expect(await held(BOB, 'BTC')).toBe('2');
    });

    it('refuses a market buy with no ask to price against', async () => {
      await fund(ALICE, 'USDT', '1000');
      matching.asks = [];

      await expect(
        trade.placeOrder(principalFor(ALICE), {
          clientOrderId: 'auto-cli-8',
          marketId: btcusdt.id,
          side: 'buy',
          type: 'market',
          qty: amt('2'),
        }),
      ).rejects.toMatchObject({ code: 'trade.no_reference_price' });

      expect(await held(ALICE, 'USDT')).toBe('0');
    });

    it('refuses place without clientOrderId — a retry would double-hold', async () => {
      await fund(ALICE, 'USDT', '1000');
      matching.asks = [['100', '5']];
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'market',
          qty: amt('1'),
        }),
      ).rejects.toMatchObject({ code: 'trade.client_order_id_required' });
      expect(matching.submitted).toHaveLength(0);
      expect(await held(ALICE, 'USDT')).toBe('0');
    });
  });

  // ── Doctrine ──────────────────────────────────────────────────────────────

  describe('doctrine §0.6 — no balance outside the ledger', () => {
    it("filled_qty always equals the sum of the order's fills", async () => {
      await fund(BOB, 'BTC', '10');
      await fund(ALICE, 'USDT', '2000');

      const maker = await rest(BOB, btcusdt, 'sell', '10', '100', 'bob-1');
      matching.scriptFills(
        [
          { makerOrderId: maker.id, makerAccountId: BOB, price: '100', qty: '3' },
          { makerOrderId: maker.id, makerAccountId: BOB, price: '100', qty: '2' },
        ],
        { restRemainder: '5' },
      );
      const taker = await rest(ALICE, btcusdt, 'buy', '10', '100', 'alice-1');

      const rows = await sql<Array<{ id: string; filled_qty: string; summed: string }>>`
        SELECT o.id, o.filled_qty, COALESCE((SELECT SUM(f.qty) FROM trade.fills f WHERE f.order_id = o.id), 0) AS summed
          FROM trade.orders o
      `;
      for (const row of rows) expect(amt(row.filled_qty)).toBe(amt(row.summed));

      const takerRow = rows.find((r) => r.id === taker.id)!;
      expect(amt(takerRow.filled_qty)).toBe(amt('5'));
    });

    it("every open order's hold is exactly what the ledger says it holds", async () => {
      await fund(ALICE, 'USDT', '5000');
      await fund(ALICE, 'BTC', '5');

      await rest(ALICE, btcusdt, 'buy', '2', '100', 'a1');
      await rest(ALICE, btcusdt, 'buy', '3', '200', 'a2');
      await rest(ALICE, btcusdt, 'sell', '1', '300', 'a3');

      // Two independent answers to "what is locked": this service's order rows,
      // and the ledger's hold accounts. That they CAN be compared is the point
      // of keeping value in the ledger and only order state here.
      const rows = await sql<Array<{ hold_asset: string; total: string }>>`
        SELECT hold_asset, SUM(hold_amount) AS total FROM trade.orders WHERE status = 'open' GROUP BY hold_asset
      `;
      const byAsset = Object.fromEntries(rows.map((r) => [r.hold_asset, amt(r.total)]));

      expect(byAsset.USDT).toBe(amt(await held(ALICE, 'USDT')));
      expect(byAsset.BTC).toBe(amt(await held(ALICE, 'BTC')));
      expect(formatAmount(byAsset.USDT!)).toBe('800');
    });

    it('holds no numeric balance column of its own — hold_amount never changes', async () => {
      await fund(BOB, 'BTC', '10');
      await fund(ALICE, 'USDT', '2000');

      const maker = await rest(BOB, btcusdt, 'sell', '10', '100', 'bob-1');
      matching.scriptFills([{ makerOrderId: maker.id, makerAccountId: BOB, price: '100', qty: '4' }], { restRemainder: '6' });
      const order = await rest(ALICE, btcusdt, 'buy', '10', '100', 'alice-1');

      const after = await sql<Array<{ hold_amount: string }>>`SELECT hold_amount FROM trade.orders WHERE id = ${order.id}`;
      // The hold is recorded, not tracked. What is still owed is derived from
      // the fills, so there is no third number that could disagree with the
      // other two.
      expect(amt(after[0]!.hold_amount)).toBe(amt('1000'));
    });
  });

  // ── Reconciliation over a mixed run ───────────────────────────────────────

  describe('reconciliation', () => {
    it('is clean after a run of mixed operations', async () => {
      await fund(ALICE, 'USDT', '10000');
      await fund(BOB, 'BTC', '20');
      await fund(CAROL, 'USDT', '5000');
      await fund(CAROL, 'ETH', '10');
      perks.discounts.set(CAROL, 275);

      // 1 · a full fill
      const m1 = await rest(BOB, btcusdt, 'sell', '2', '100', 'bob-1');
      matching.scriptFills([{ makerOrderId: m1.id, makerAccountId: BOB, price: '100', qty: '2' }]);
      await rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-1');

      // 2 · a partial fill that then rests, then is cancelled
      const m2 = await rest(BOB, btcusdt, 'sell', '10', '101', 'bob-2');
      matching.scriptFills([{ makerOrderId: m2.id, makerAccountId: BOB, price: '101', qty: '4' }], { restRemainder: '6' });
      const partial = await rest(ALICE, btcusdt, 'buy', '10', '101', 'alice-2');
      await trade.cancelOrder(principalFor(ALICE), partial.id);

      // 3 · an order cancelled untouched
      const untouched = await rest(ALICE, btcusdt, 'buy', '1', '90', 'alice-3');
      await trade.cancelOrder(principalFor(ALICE), untouched.id);

      // 4 · an engine rejection
      matching.scriptRejection('fok_unfillable');
      await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('95'),
        tif: 'FOK',
        clientOrderId: 'alice-fok',
      });

      // 5 · a discounted fill on the fat-fee market
      const m3 = await rest(CAROL, ethusdt, 'sell', '2', '50', 'carol-1');
      matching.scriptFills([{ makerOrderId: m3.id, makerAccountId: CAROL, price: '50', qty: '2' }]);
      await rest(ALICE, ethusdt, 'buy', '2', '50', 'alice-4');

      // 6 · a retry of something already placed
      await rest(ALICE, btcusdt, 'buy', '1', '90', 'alice-3');

      // 7 · redelivered events over the whole run
      for (const row of await sql<Array<{ order_id: string }>>`SELECT DISTINCT order_id FROM trade.fills`) {
        await trade.releaseOnCancelEvent(row.order_id);
      }

      expect(ledger.reconcile()).toEqual({ ok: true });
      expect(ledger.verifyChain()).toEqual({ ok: true });
      expect(ledger.totalsByAsset()).toEqual({ BTC: '0', ETH: '0', USDT: '0' });

      // No user's hold ever went negative, and no order over-consumed its hold.
      for (const user of [ALICE, BOB, CAROL]) {
        for (const asset of ['BTC', 'ETH', 'USDT']) {
          expect(amt(await held(user, asset))).toBeGreaterThanOrEqual(0n);
          expect(amt(await avail(user, asset))).toBeGreaterThanOrEqual(0n);
        }
      }

      // Every terminal order has nothing left held against it.
      const terminal = await sql<Array<{ id: string; hold_amount: string; consumed: string }>>`
        SELECT o.id, o.hold_amount,
               COALESCE((SELECT SUM(CASE WHEN o.side = 'buy' THEN f.quote_amount ELSE f.qty END)
                           FROM trade.fills f WHERE f.order_id = o.id), 0) AS consumed
          FROM trade.orders o WHERE o.status IN ('filled', 'cancelled', 'rejected', 'expired')
      `;
      for (const row of terminal) expect(amt(row.hold_amount)).toBeGreaterThanOrEqual(amt(row.consumed));
    });
  });

  describe('trade.convert — firm RFQ (not a book trade)', () => {
    beforeEach(() => {
      trade = new TradeService(sql, ledger, matching, perks, bus, {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
        marketSlippageCapBps: 150,
        convertEnabled: true,
        convertSpreadBps: 25,
      });
      matching.asks = [['100', '10']];
      matching.bids = [['99', '10']];
    });

    it('quotes a buy against asks with house convert spread, source, expiry, exact in/out', async () => {
      const quote = await trade.convertQuote(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        qty: amt('1'),
      });
      expect(quote.symbol).toBe('BTC/USDT');
      expect(quote.fullyFilled).toBe(true);
      expect(quote.convertSpreadBps).toBe(25);
      expect(quote.quoteId).toBeTruthy();
      expect(quote.source.kind).toBe('book');
      expect(quote.source.symbol).toBe('BTC/USDT');
      expect(quote.expiresAt).toBeTruthy();
      expect(quote.inAsset).toBe('USDT');
      expect(quote.outAsset).toBe('BTC');
      expect(quote.inAmount).toBe(quote.userNotional);
      expect(quote.outAmount).toBe(quote.filledQty);
      expect(amt(quote.userNotional)).toBeGreaterThan(amt(quote.bookNotional));
    });

    it('refuses to quote when the book is empty', async () => {
      matching.asks = [];
      await expect(trade.convertQuote(principalFor(ALICE), { marketId: btcusdt.id, side: 'buy', qty: amt('1') })).rejects.toMatchObject({
        code: 'trade.convert_no_liquidity',
      });
    });

    it('accepts the stored quote via ledger (not matching) and is idempotent on quoteId', async () => {
      await fund(ALICE, 'USDT', '1000');
      await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: amt('10'), seedId: 'convert-mm-btc' }));

      const quote = await trade.convertQuote(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        qty: amt('1'),
      });
      const first = await trade.convertExecute(principalFor(ALICE), { quoteId: quote.quoteId });
      expect(first.quoteId).toBe(quote.quoteId);
      expect(first.inAmount).toBe(quote.inAmount);
      expect(first.outAmount).toBe(quote.outAmount);
      expect(matching.submitted).toHaveLength(0);

      matching.asks = [['999', '10']];
      const second = await trade.convertExecute(principalFor(ALICE), { quoteId: quote.quoteId });
      expect(second.fillId).toBe(first.fillId);
      expect(second.fillNotional).toBe(first.fillNotional);
      expect(matching.submitted).toHaveLength(0);
    });

    it('refuses accept without a quote — never invents a mid', async () => {
      await expect(trade.convertExecute(principalFor(ALICE), { quoteId: '00000000-0000-4000-8000-00000000c0de' })).rejects.toMatchObject({
        code: 'trade.convert_quote_missing',
      });
      expect(matching.submitted).toHaveLength(0);
    });

    it('refuses accept when maxAvgPrice does not match the quoted avg', async () => {
      await fund(ALICE, 'USDT', '1000');
      await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: amt('10'), seedId: 'convert-mm-btc-ll' }));
      const quote = await trade.convertQuote(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        qty: amt('1'),
      });
      await expect(
        trade.convertExecute(principalFor(ALICE), {
          quoteId: quote.quoteId,
          maxAvgPrice: amt('150'),
        }),
      ).rejects.toMatchObject({ code: 'trade.convert_price_moved' });
      expect(matching.submitted).toHaveLength(0);
    });

    it('refuses accept after expiry rather than requoting the book', async () => {
      const clock = { now: new Date('2026-08-26T12:00:00.000Z') };
      trade = new TradeService(sql, ledger, matching, perks, bus, {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
        convertEnabled: true,
        convertSpreadBps: 25,
        convertQuoteTtlMs: 1_000,
        now: () => clock.now,
      });
      matching.asks = [['100', '10']];
      const quote = await trade.convertQuote(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        qty: amt('1'),
      });
      clock.now = new Date('2026-08-26T12:00:02.000Z');
      await expect(trade.convertExecute(principalFor(ALICE), { quoteId: quote.quoteId })).rejects.toMatchObject({
        code: 'trade.convert_quote_expired',
      });
      expect(matching.submitted).toHaveLength(0);
    });

    it('refuses convert quote and execute when spread is unset — never invents 10', async () => {
      const unset = new TradeService(sql, ledger, matching, perks, bus, {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
        convertEnabled: true,
      });
      await expect(unset.convertQuote(principalFor(ALICE), { marketId: btcusdt.id, side: 'buy', qty: amt('1') })).rejects.toMatchObject({
        code: 'trade.convert_spread_unset',
      });
      await expect(unset.convertExecute(principalFor(ALICE), { quoteId: '00000000-0000-4000-8000-00000000c0de' })).rejects.toMatchObject({
        code: 'trade.convert_spread_unset',
      });
      expect(matching.submitted).toHaveLength(0);
    });

    it('refuses convert quote when spread is not an integer', async () => {
      const bad = new TradeService(sql, ledger, matching, perks, bus, {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
        convertEnabled: true,
        convertSpreadBps: Number.NaN,
      });
      await expect(bad.convertQuote(principalFor(ALICE), { marketId: btcusdt.id, side: 'buy', qty: amt('1') })).rejects.toMatchObject({
        code: 'trade.convert_spread_unset',
      });
    });

    it('honours the convert kill-switch', async () => {
      trade = new TradeService(sql, ledger, matching, perks, bus, {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: READY_MARKET_LIFECYCLE,
        convertEnabled: false,
      });
      await expect(trade.convertQuote(principalFor(ALICE), { marketId: btcusdt.id, side: 'buy', qty: amt('1') })).rejects.toMatchObject({
        code: 'trade.convert_disabled',
      });
    });

    /**
     * convertQuote must share assertMarketOpen with placeOrder. Without it, a
     * Saturday EUR/USD convert still returns a price while placeOrder refuses
     * market_closed — the user sees a fundable quote for a venue that cannot
     * fill until Monday.
     */
    it('refuses convertQuote when the forex venue is shut (same gate as placeOrder)', async () => {
      const eurusd = await trade.listMarket({
        symbol: 'EUR/USD-CONVERT',
        baseAsset: 'EUR',
        quoteAsset: 'USD',
        tickSize: amt('0.00001'),
        lotSize: amt('0.01'),
        minQty: amt('0.01'),
        maxQty: null,
        minNotional: amt('1'),
        makerBps: 10,
        takerBps: 20,
        assetClass: 'forex',
        schedule: 'fx-global',
        paper: true,
      });

      matching.asks = [['1.10000', '1000']];
      matching.bids = [['1.09900', '1000']];

      const saturday = new TradeService(sql, ledger, matching, perks, bus, {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
        convertEnabled: true,
        convertSpreadBps: 25,
        now: () => new Date('2026-01-10T12:00:00Z'),
      });

      await expect(
        saturday.convertQuote(principalFor(ALICE), {
          marketId: eurusd.id,
          side: 'buy',
          qty: amt('100'),
        }),
      ).rejects.toMatchObject({ code: 'trade.market_closed' });

      // Mid-session: same listing, same book, open clock → quote is honest.
      const wednesday = new TradeService(sql, ledger, matching, perks, bus, {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
        convertEnabled: true,
        convertSpreadBps: 25,
        now: () => new Date('2026-01-14T12:00:00Z'),
      });
      const quote = await wednesday.convertQuote(principalFor(ALICE), {
        marketId: eurusd.id,
        side: 'buy',
        qty: amt('100'),
      });
      expect(quote.symbol).toBe('EUR/USD-CONVERT');
      expect(quote.fullyFilled).toBe(true);
    });
  });

  // ── OHLCV aggregation ─────────────────────────────────────────────────────

  /**
   * `fetchOHLCV` used to return `[]` unconditionally. These prove the candles
   * are measurements of real fills and nothing else.
   *
   * Fills are produced by real matched trades, then their `ts` is moved to
   * chosen instants so bucket boundaries are deterministic rather than
   * dependent on how fast the suite ran. Prices and quantities are untouched —
   * they are the values under test.
   */
  describe('candles (fetchOHLCV)', () => {
    /**
     * 2023-11-14T22:00:00Z — genuinely on a 1m AND a 1h boundary, so every
     * expected bucket below is arithmetic rather than a guess. (The obvious
     * round-looking 1_700_000_000_000 is 22:13:20 and is aligned to neither.)
     */
    const T0 = 1_699_999_200_000;

    /** Trade `qty` at `price`, then move the resulting fills to `atMs`. */
    async function tradeOne(price: string, qty: string, atMs: number, tag: string) {
      const [before] = await sql<Array<{ n: string }>>`
        SELECT coalesce(max(sequence), -1)::text AS n FROM trade.fills
      `;
      const from = Number(before!.n);

      await fund(BOB, 'BTC', qty);
      await fund(ALICE, 'USDT', String(Number(price) * Number(qty)));
      const maker = await rest(BOB, btcusdt, 'sell', qty, price, `bob-${tag}`);
      matching.scriptFills([{ makerOrderId: maker.id, makerAccountId: BOB, price, qty }]);
      await rest(ALICE, btcusdt, 'buy', qty, price, `alice-${tag}`);

      await sql`UPDATE trade.fills SET ts = ${new Date(atMs)} WHERE sequence > ${from}`;
    }

    it('returns no candles for a market that has never traded', async () => {
      expect(await trade.candles(btcusdt.id, '1m')).toEqual([]);
    });

    it('builds one candle per bucket from real fills, oldest first', async () => {
      // Three trades, two of them inside the same minute.
      await tradeOne('100', '1', T0 + 5_000, 'a');
      await tradeOne('105', '2', T0 + 30_000, 'b');
      await tradeOne('99', '1', T0 + 65_000, 'c');

      const candles = await trade.candles(btcusdt.id, '1m');
      expect(candles).toHaveLength(2);

      // CCXT order is oldest → newest.
      expect(candles[0]!.openTimeMs).toBe(T0);
      expect(candles[1]!.openTimeMs).toBe(T0 + 60_000);

      // Bucket one: opened at 100, high 105, low 100, closed at 105, volume 3.
      expect(formatAmount(candles[0]!.open)).toBe('100');
      expect(formatAmount(candles[0]!.high)).toBe('105');
      expect(formatAmount(candles[0]!.low)).toBe('100');
      expect(formatAmount(candles[0]!.close)).toBe('105');
      expect(formatAmount(candles[0]!.volume)).toBe('3');

      // Bucket two: a single print.
      expect(formatAmount(candles[1]!.open)).toBe('99');
      expect(formatAmount(candles[1]!.close)).toBe('99');
      expect(formatAmount(candles[1]!.volume)).toBe('1');
    });

    /**
     * The gap stays a gap. A zero-filled candle at price 0 is a print that
     * never happened, and an indicator computed across it is a number we made
     * up and handed to someone who trades on it.
     */
    it('omits an empty bucket rather than zero-filling it', async () => {
      await tradeOne('100', '1', T0 + 1_000, 'a');
      await tradeOne('110', '1', T0 + 180_000, 'b'); // two minutes later

      const candles = await trade.candles(btcusdt.id, '1m');
      expect(candles).toHaveLength(2);
      expect(candles.map((c) => c.openTimeMs)).toEqual([T0, T0 + 180_000]);
      // No candle exists for the silent minutes in between.
      expect(candles.some((c) => c.openTimeMs === T0 + 60_000)).toBe(false);
      expect(candles.every((c) => c.volume > 0n)).toBe(true);
    });

    it('buckets by the requested timeframe', async () => {
      await tradeOne('100', '1', T0 + 1_000, 'a');
      await tradeOne('120', '1', T0 + 1_800_000, 'b'); // +30m — same hour

      expect(await trade.candles(btcusdt.id, '1m')).toHaveLength(2);

      const hourly = await trade.candles(btcusdt.id, '1h');
      expect(hourly).toHaveLength(1);
      expect(hourly[0]!.openTimeMs).toBe(T0);
      expect(formatAmount(hourly[0]!.open)).toBe('100');
      expect(formatAmount(hourly[0]!.close)).toBe('120');
      expect(formatAmount(hourly[0]!.high)).toBe('120');
      expect(formatAmount(hourly[0]!.volume)).toBe('2');
    });

    it('honours since, and a limit keeps the most recent buckets', async () => {
      await tradeOne('100', '1', T0 + 1_000, 'a');
      await tradeOne('101', '1', T0 + 61_000, 'b');
      await tradeOne('102', '1', T0 + 121_000, 'c');

      const since = await trade.candles(btcusdt.id, '1m', 500, T0 + 60_000);
      expect(since.map((c) => c.openTimeMs)).toEqual([T0 + 60_000, T0 + 120_000]);

      // A limit keeps the newest buckets — a chart opens on its right edge —
      // and still hands them back oldest-first.
      const limited = await trade.candles(btcusdt.id, '1m', 2);
      expect(limited.map((c) => c.openTimeMs)).toEqual([T0 + 60_000, T0 + 120_000]);
    });

    it('never mixes another market into a candle', async () => {
      await tradeOne('100', '1', T0 + 1_000, 'a');
      expect(await trade.candles(ethusdt.id, '1m')).toEqual([]);
      expect(await trade.candles(btcusdt.id, '1m')).toHaveLength(1);
    });

    /**
     * Each match writes two fill rows, taker and maker. Counting both would
     * double every candle's volume — the same trap `publicTape` avoids by
     * filtering to the taker leg.
     */
    it('counts each match once, not once per fill leg', async () => {
      await tradeOne('100', '3', T0 + 1_000, 'a');
      const [legs] = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.fills`;
      expect(legs!.n).toBe('2');

      const candles = await trade.candles(btcusdt.id, '1m');
      expect(candles).toHaveLength(1);
      expect(formatAmount(candles[0]!.volume)).toBe('3');
    });
  });

  /**
   * academy.paper-trading Stage-1 — paper market flag + ledger isolation.
   * Live markets keep the funded placeOrder path; paper never posts holds.
   */
  describe('paper market isolation (Stage-1)', () => {
    it('lists a paper market with paper=true; live default is false', async () => {
      expect(btcusdt.paper).toBe(false);
      const paperMkt = await trade.listMarket({
        symbol: 'BTC/USDT-PAPER',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        tickSize: amt('0.01'),
        lotSize: amt('0.0001'),
        minQty: amt('0.0001'),
        maxQty: amt('1000'),
        minNotional: amt('1'),
        makerBps: 0,
        takerBps: 0,
        paper: true,
      });
      expect(paperMkt.paper).toBe(true);
    });

    it('placeOrder on paper never debits real available balances', async () => {
      const paperMkt = await trade.listMarket({
        symbol: 'ETH/USDT-PAPER',
        baseAsset: 'ETH',
        quoteAsset: 'USDT',
        tickSize: amt('0.01'),
        lotSize: amt('0.001'),
        minQty: amt('0.001'),
        maxQty: null,
        minNotional: amt('1'),
        makerBps: 0,
        takerBps: 0,
        paper: true,
      });
      await fund(ALICE, 'USDT', '10000');
      const before = await avail(ALICE, 'USDT');
      const journalBefore = ledger.journal().length;

      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: paperMkt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'paper-buy-1',
      });

      expect(order.status).toBe('open');
      expect(formatAmount(order.holdAmount)).toBe('0');
      expect(await avail(ALICE, 'USDT')).toBe(before);
      expect(await held(ALICE, 'USDT')).toBe('0');
      expect(ledger.journal().length).toBe(journalBefore);
      expect(matching.submitted).toHaveLength(0);
    });

    it('live market placeOrder still holds real funds (unchanged)', async () => {
      await fund(ALICE, 'USDT', '5000');
      matching.script1((req, next) => restsInFull(req, next()));
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('0.01'),
        price: amt('100'),
        clientOrderId: 'live-buy-1',
      });
      expect(order.status).toBe('open');
      expect(formatAmount(order.holdAmount)).not.toBe('0');
      expect(await held(ALICE, 'USDT')).not.toBe('0');
    });
  });
}
