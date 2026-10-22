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


  describe('idempotency', () => {
    it('a retry with the same client order id holds once and submits once', async () => {
      await fund(ALICE, 'USDT', '2000');

      const first = await rest(ALICE, btcusdt, 'buy', '2', '100', 'retry-me');
      const second = await rest(ALICE, btcusdt, 'buy', '2', '100', 'retry-me');
      const third = await rest(ALICE, btcusdt, 'buy', '2', '100', 'retry-me');

      expect(second.id).toBe(first.id);
      expect(third.id).toBe(first.id);
      expect(first.id).toBe(orderIdFor(ALICE, btcusdt.id, 'retry-me'));

      // One row, one hold, one engine submission.
      expect(await sql`SELECT id FROM trade.orders`).toHaveLength(1);
      expect(matching.submitted).toHaveLength(1);
      expect(postsWithReason('order.hold')).toHaveLength(1);
      expect(await held(ALICE, 'USDT')).toBe('200');
      expect(await avail(ALICE, 'USDT')).toBe('1800');
    });

    it('the same client id from a different user is a different order', async () => {
      await fund(ALICE, 'USDT', '1000');
      await fund(CAROL, 'USDT', '1000');

      const a = await rest(ALICE, btcusdt, 'buy', '2', '100', 'order-1');
      const c = await rest(CAROL, btcusdt, 'buy', '2', '100', 'order-1');

      expect(a.id).not.toBe(c.id);
      expect(await sql`SELECT id FROM trade.orders`).toHaveLength(2);
    });

    it('concurrent identical submissions produce one order and one hold', async () => {
      await fund(ALICE, 'USDT', '2000');

      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          rest(ALICE, btcusdt, 'buy', '2', '100', 'racy')
            .then((o) => o.id)
            .catch(() => 'failed'),
        ),
      );

      const ids = new Set(results.filter((r) => r !== 'failed'));
      expect(ids.size).toBe(1);
      expect(postsWithReason('order.hold')).toHaveLength(1);
      expect(await held(ALICE, 'USDT')).toBe('200');
    });

    it('a redelivered fill event settles nothing a second time', async () => {
      await fund(BOB, 'BTC', '5');
      await fund(ALICE, 'USDT', '1000');

      const maker = await rest(BOB, btcusdt, 'sell', '2', '100', 'bob-1');
      matching.scriptFills([{ makerOrderId: maker.id, makerAccountId: BOB, price: '100', qty: '2' }]);
      const taker = await rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-1');

      const sequence = (await sql<Array<{ sequence: number }>>`SELECT sequence FROM trade.fills LIMIT 1`)[0]!.sequence;

      // The engine publishes every match to NATS regardless of who submitted
      // it, so this is the ordinary recovery path, not an exotic one.
      await trade.settleFillEvent({
        marketId: btcusdt.id,
        makerOrderId: maker.id,
        takerOrderId: taker.id,
        price: '100',
        qty: '2',
        sequence,
        makerAccountId: BOB,
        takerAccountId: ALICE,
      });

      expect(postsWithReason('trade.fill')).toHaveLength(1);
      expect(await sql`SELECT id FROM trade.fills`).toHaveLength(2);
      expect(await avail(ALICE, 'BTC')).toBe('1.996');
      expect(ledger.totalsByAsset()).toEqual({ BTC: '0', USDT: '0' });
    });

    it('fee-exhausting match refuses BEFORE fill rows — hold stays whole, re-run can heal', async () => {
      /**
       * markets_dust_free_ck requires tick×lot ≥ 1 wei — so both cannot be 1 wei
       * (product 1e-36). Use tick=1, lot=1 wei so the listing is legal; any
       * non-zero fee then ceil-rounds a 1-wei receivable to the whole amount.
       * Recipe refuses; if fill rows landed first, remainingHold permanently
       * overstated consumption. Guard must fire first so a cancel still returns
       * the full hold.
       */
      const dust = await trade.listMarket({
        symbol: 'DUST/USDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        tickSize: amt('1'),
        lotSize: amt('0.000000000000000001'),
        minQty: amt('0.000000000000000001'),
        maxQty: amt('1'),
        minNotional: amt('0.000000000000000001'),
        makerBps: 10,
        takerBps: 20,
      });
      await fund(BOB, 'BTC', '1');
      await fund(ALICE, 'USDT', '1');

      // rest(user, market, side, qty, price, clientId) — qty on lot (1 wei), price on tick (1)
      const maker = await rest(BOB, dust, 'sell', '0.000000000000000001', '1', 'bob-dust');
      matching.scriptFills([
        {
          makerOrderId: maker.id,
          makerAccountId: BOB,
          price: '1',
          qty: '0.000000000000000001',
        },
      ]);

      await expect(rest(ALICE, dust, 'buy', '0.000000000000000001', '1', 'alice-dust')).rejects.toMatchObject({
        code: 'trade.fee_exceeds_fill',
      });

      expect(await sql`SELECT id FROM trade.fills`).toHaveLength(0);
      expect(postsWithReason('trade.fill')).toHaveLength(0);
      // Maker still open with full hold — nothing was drawn by a phantom fill.
      expect(formatAmount((await ledger.balance(orderHoldAccount(BOB, 'BTC', maker.id))).amount)).toBe('0.000000000000000001');
      expect(ledger.totalsByAsset()).toEqual({ BTC: '0', USDT: '0' });
    });

    it('recovery settleFillEvent with house MM makerAccountId settles marketMakerMakerFill', async () => {
      // Inline path already covered above; this is the crash-between-engine-and-
      // settle recovery path: no trade.orders row for the seed maker, only the
      // matching event carrying makerAccountId = house:market-maker.
      await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: amt('10'), seedId: 'mm-rec-1' }));
      const mmOrderId = mmSeedOrderIdFor('recovery-run', btcusdt.id, 'sell', 1);
      await ledger.post(recipes.marketMakerOrderHold({ orderId: mmOrderId, assetId: 'BTC', amount: amt('1') }));
      await fund(ALICE, 'USDT', '1000');

      // Rest taker only (no match yet). Hold funded; then simulate engine fill
      // arriving as an event with real house MM account id.
      matching.script1((request, next) => restsInFull(request, next()));
      const taker = await rest(ALICE, btcusdt, 'buy', '1', '100', 'alice-mm-recovery');
      expect(postsWithReason('trade.fill.mm_maker')).toHaveLength(0);
      expect(await sql`SELECT id FROM trade.orders WHERE id = ${mmOrderId}`).toHaveLength(0);

      await trade.settleFillEvent({
        marketId: btcusdt.id,
        makerOrderId: mmOrderId,
        takerOrderId: taker.id,
        price: '100',
        qty: '1',
        sequence: 42,
        makerAccountId: MM_MATCHING_ACCOUNT_ID,
        takerAccountId: ALICE,
      });

      expect(postsWithReason('trade.fill.mm_maker')).toHaveLength(1);
      expect(formatAmount((await ledger.balance(marketMakerOrderHoldAccount('BTC', mmOrderId))).amount)).toBe('0');
      expect(formatAmount((await ledger.balance(marketMaker('USDT'))).amount)).toBe('99.9');
      expect(await avail(ALICE, 'BTC')).toBe('0.998');
      expect(ledger.totalsByAsset()).toEqual({ BTC: '0', USDT: '0' });
    });

    it('recovery without makerAccountId does not invent house MM or balances for unknown maker', async () => {
      await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: amt('10'), seedId: 'mm-rec-empty' }));
      const mmOrderId = mmSeedOrderIdFor('empty-acct-run', btcusdt.id, 'sell', 1);
      await ledger.post(recipes.marketMakerOrderHold({ orderId: mmOrderId, assetId: 'BTC', amount: amt('1') }));
      await fund(ALICE, 'USDT', '1000');

      matching.script1((request, next) => restsInFull(request, next()));
      const taker = await rest(ALICE, btcusdt, 'buy', '1', '100', 'alice-empty-maker-acct');
      const usdtBefore = await avail(ALICE, 'USDT');
      const btcBefore = await avail(ALICE, 'BTC');
      const mmHoldBefore = formatAmount((await ledger.balance(marketMakerOrderHoldAccount('BTC', mmOrderId))).amount);

      // Empty / omitted makerAccountId + no trade.orders row → order_not_found.
      // Must not route through marketMakerMakerFill or move balances.
      await expect(
        trade.settleFillEvent({
          marketId: btcusdt.id,
          makerOrderId: mmOrderId,
          takerOrderId: taker.id,
          price: '100',
          qty: '1',
          sequence: 99,
          makerAccountId: '',
          takerAccountId: ALICE,
        }),
      ).rejects.toMatchObject({ code: 'trade.order_not_found' });

      expect(postsWithReason('trade.fill.mm_maker')).toHaveLength(0);
      expect(postsWithReason('trade.fill')).toHaveLength(0);
      expect(await avail(ALICE, 'USDT')).toBe(usdtBefore);
      expect(await avail(ALICE, 'BTC')).toBe(btcBefore);
      expect(formatAmount((await ledger.balance(marketMakerOrderHoldAccount('BTC', mmOrderId))).amount)).toBe(mmHoldBefore);
    });

    it('recovery from recorded seed row without event accountId is house STP, not an anonymous customer', async () => {
      // recordSeededOrder writes HOUSE_MM_USER_UUID. Older orderFilled payloads
      // omit makerAccountId — recovery must yield house:market-maker, not the
      // bookkeeping UUID (that looks like a live customer fill).
      await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: amt('10'), seedId: 'mm-rec-row' }));
      const mmOrderId = mmSeedOrderIdFor('recorded-run', btcusdt.id, 'sell', 1);
      await ledger.post(recipes.marketMakerOrderHold({ orderId: mmOrderId, assetId: 'BTC', amount: amt('1') }));
      await fund(ALICE, 'USDT', '1000');

      matching.script1((request, next) => restsInFull(request, next()));
      const taker = await rest(ALICE, btcusdt, 'buy', '1', '100', 'alice-mm-recorded');

      await sql`
        INSERT INTO trade.orders (
          id, user_id, market_id, side, type, price, qty, status, tif,
          hold_asset, hold_amount, fee_discount_bps, seeded
        ) VALUES (
          ${mmOrderId}, ${HOUSE_MM_USER_UUID}, ${btcusdt.id}, ${'sell'}, ${'limit'},
          ${'100'}::numeric, ${'1'}::numeric, ${'open'}, ${'PO'},
          ${'BTC'}, ${'1'}::numeric, ${0}, ${true}
        )
      `;

      const recovered = recoverMatchingAccountId({
        eventAccountId: '',
        orderUserId: HOUSE_MM_USER_UUID,
      });
      expect(looksLikeAnonymousCustomerFill(recovered)).toBe(false);
      expect(recovered).toBe(MM_MATCHING_ACCOUNT_ID);

      await trade.settleFillEvent({
        marketId: btcusdt.id,
        makerOrderId: mmOrderId,
        takerOrderId: taker.id,
        price: '100',
        qty: '1',
        sequence: 77,
        takerAccountId: ALICE,
      });

      expect(postsWithReason('trade.fill.mm_maker')).toHaveLength(1);
      expect(postsWithReason('trade.fill')).toHaveLength(0);
      expect(formatAmount((await ledger.balance(marketMakerOrderHoldAccount('BTC', mmOrderId))).amount)).toBe('0');
      expect(await avail(ALICE, 'BTC')).toBe('0.998');
    });
  });

  // ── Fee tiers ─────────────────────────────────────────────────────────────

  describe('owner fee schedule on place/fill', () => {
    it('unpublished schedule refuses place — never listing-row 10/20 and never a hold', async () => {
      await fund(ALICE, 'USDT', '1000');
      const closed = new TradeService(sql, ledger, matching, perks, bus, {
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
        feeSchedule: UNPUBLISHED_FEE_SCHEDULE,
      });
      await expect(
        closed.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('2'),
          price: amt('100'),
          clientOrderId: 'alice-blank-fee',
        }),
      ).rejects.toMatchObject({ code: 'trade.fee_schedule_blank' });
      expect(await sql`SELECT id FROM trade.orders`).toHaveLength(0);
      expect(await held(ALICE, 'USDT')).toBe('0');
      expect(matching.submitted).toHaveLength(0);
    });

    it('fill uses owner schedule bps, not listing-row maker_bps/taker_bps', async () => {
      const schedule = parseFeeScheduleJson(
        JSON.stringify({ published: true, version: 'place-not-listing', makerBps: '1', takerBps: '5' }),
      );
      trade = new TradeService(sql, ledger, matching, perks, bus, {
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
        marketSlippageCapBps: 150,
        feeSchedule: schedule,
      });
      expect(btcusdt.makerBps).toBe(10);
      expect(btcusdt.takerBps).toBe(20);

      await fund(BOB, 'BTC', '5');
      await fund(ALICE, 'USDT', '1000');
      const maker = await rest(BOB, btcusdt, 'sell', '2', '100', 'bob-sched');
      matching.scriptFills([{ makerOrderId: maker.id, makerAccountId: BOB, price: '100', qty: '2' }]);
      await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('2'),
        price: amt('100'),
        clientOrderId: 'alice-sched',
      });

      // Owner 5/1 bps, not listing 20/10: Alice receives 2 − 5 bps; Bob 200 − 1 bps.
      expect(await avail(ALICE, 'BTC')).toBe('1.999');
      expect(await avail(BOB, 'USDT')).toBe('199.98');
      expect(await fees('BTC')).toBe('0.001');
      expect(await fees('USDT')).toBe('0.02');

      const legs = await sql<Array<{ fee_amount: string; fee_bps: string; liquidity: string }>>`
        SELECT fee_amount::text AS fee_amount, fee_bps::text AS fee_bps, liquidity FROM trade.fills ORDER BY liquidity
      `;
      expect(legs).toHaveLength(2);
      for (const leg of legs) {
        expect(leg.fee_amount).toMatch(/^\d+(\.\d+)?$/);
        expect(leg.fee_bps).toMatch(/^\d+$/);
      }
      expect(legs.map((l) => l.fee_bps).sort()).toEqual(['1', '5']);
      expect(ledger.totalsByAsset()).toEqual({ BTC: '0', USDT: '0' });
    });
  });

  describe('rank fee discount', () => {
    beforeEach(() => {
      // Venue-wide owner schedule — listing-row 100/200 is not the rate.
      trade = new TradeService(sql, ledger, matching, perks, bus, {
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
        marketSlippageCapBps: 150,
        feeSchedule: parseFeeScheduleJson(JSON.stringify({ published: true, version: 'rank-test', makerBps: '100', takerBps: '200' })),
      });
    });

    it('a discounted taker pays strictly less, and the house receives strictly less', async () => {
      // Rank 7 — 350 bps off. ETH/USDT charges 200 bps taker, so the discount
      // is representable in integer basis points.
      perks.discounts.set(ALICE, 350);

      await fund(BOB, 'ETH', '10');
      await fund(ALICE, 'USDT', '1000');
      await fund(CAROL, 'USDT', '1000');

      const maker1 = await rest(BOB, ethusdt, 'sell', '1', '100', 'bob-1');
      matching.scriptFills([{ makerOrderId: maker1.id, makerAccountId: BOB, price: '100', qty: '1' }]);
      await rest(ALICE, ethusdt, 'buy', '1', '100', 'alice-1');

      const maker2 = await rest(BOB, ethusdt, 'sell', '1', '100', 'bob-2');
      matching.scriptFills([{ makerOrderId: maker2.id, makerAccountId: BOB, price: '100', qty: '1' }]);
      await rest(CAROL, ethusdt, 'buy', '1', '100', 'carol-1');

      // 200 bps on 1 ETH = 0.02. With 350 bps off the rate: 193 bps = 0.0193.
      expect(await avail(ALICE, 'ETH')).toBe('0.9807');
      expect(await avail(CAROL, 'ETH')).toBe('0.98');

      const discounted = amt(await avail(ALICE, 'ETH'));
      const full = amt(await avail(CAROL, 'ETH'));
      expect(discounted).toBeGreaterThan(full);

      const rates = await sql<Array<{ fee_bps: string }>>`
        SELECT fee_bps FROM trade.fills WHERE user_id = ${ALICE} AND liquidity = 'taker'
      `;
      expect(Number(rates[0]!.fee_bps)).toBe(193);

      expect(ledger.totalsByAsset()).toEqual({ ETH: '0', USDT: '0' });
    });

    it('snapshots the discount on the order, so a later rank change cannot re-price it', async () => {
      perks.discounts.set(ALICE, 350);

      await fund(BOB, 'ETH', '10');
      await fund(ALICE, 'USDT', '1000');

      const maker = await rest(BOB, ethusdt, 'sell', '1', '100', 'bob-1');
      const order = await rest(ALICE, ethusdt, 'buy', '1', '100', 'alice-1');
      expect(order.feeDiscountBps).toBe(350);

      // Alice is demoted to rank 0 AFTER placing, but before the fill.
      perks.discounts.set(ALICE, 0);

      matching.scriptFills([{ makerOrderId: maker.id, makerAccountId: BOB, price: '100', qty: '1' }]);
      const second = await rest(ALICE, ethusdt, 'buy', '1', '100', 'alice-2');
      expect(second.feeDiscountBps).toBe(0);

      // The order placed on the old terms keeps them.
      const kept = await trade.getOrder(principalFor(ALICE, ['trade:read']), order.id);
      expect(kept.feeDiscountBps).toBe(350);
    });

    it('fails closed when the perk table cannot be read — before anything is held', async () => {
      await fund(ALICE, 'USDT', '1000');
      perks.unavailable = true;

      await expect(rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-1')).rejects.toThrow();

      expect(await sql`SELECT id FROM trade.orders`).toHaveLength(0);
      expect(await held(ALICE, 'USDT')).toBe('0');
      expect(matching.submitted).toHaveLength(0);
    });
  });

  // ── Engine rejections and risk refusals ───────────────────────────────────

}
