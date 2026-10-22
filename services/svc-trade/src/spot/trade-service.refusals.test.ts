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


  describe('refusals', () => {
    it('returns the whole hold when the engine rejects the order', async () => {
      await fund(ALICE, 'USDT', '1000');
      matching.scriptRejection('post_only_would_cross');

      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('2'),
        price: amt('100'),
        tif: 'PO',
        clientOrderId: 'alice-po',
      });

      expect(order.status).toBe('rejected');
      expect(order.rejectCode).toBe('post_only_would_cross');
      expect(await avail(ALICE, 'USDT')).toBe('1000');
      expect(await held(ALICE, 'USDT')).toBe('0');
      expect(postsWithReason('order.hold.released')).toHaveLength(1);
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    it('refuses without a scope, before reading anything', async () => {
      await fund(ALICE, 'USDT', '1000');

      await expect(
        trade.placeOrder(principalFor(ALICE, ['trade:read']), {
          clientOrderId: 'auto-cli-1',
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('2'),
          price: amt('100'),
        }),
      ).rejects.toBeInstanceOf(AuthError);

      expect(await sql`SELECT id FROM trade.orders`).toHaveLength(0);
      expect(await held(ALICE, 'USDT')).toBe('0');
    });

    it('refuses an otherwise valid place when lifecycle authority is absent', async () => {
      const absentAuthority = new TradeService(sql, ledger, matching, perks, bus, {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        spotEnabled: true,
      });
      await fund(ALICE, 'USDT', '1000');

      await expect(
        absentAuthority.placeOrder(principalFor(ALICE), {
          clientOrderId: 'lifecycle-authority-absent',
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('2'),
          price: amt('100'),
        }),
      ).rejects.toMatchObject({ code: 'trade.lifecycle_authority_unavailable' });

      expect(await sql`SELECT id FROM trade.orders`).toHaveLength(0);
      expect(await held(ALICE, 'USDT')).toBe('0');
      expect(matching.submitted).toHaveLength(0);
    });

    /**
     * Sub-account ownership S2S gate (PEACE residual · mega-audit R5 follow-on).
     *
     * Accept-and-store of any UUID was the bug; fail-closed ungated was the
     * interim. These cases prove identity consult runs before hold, and only an
     * active parent-owned book is labelled onto the order.
     */
    describe('sub-account ownership gate', () => {
      const SUB_ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const SUB_BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

      function tradeWith(subAccounts: StubSubAccounts) {
        return new TradeService(sql, ledger, matching, perks, bus, {
          feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
          marketLifecycle: READY_MARKET_LIFECYCLE,
          spotEnabled: true,
          marketSlippageCapBps: 150,
          subAccounts,
        });
      }

      it('labels an order when the sub-account is owned and active', async () => {
        const subAccounts = new StubSubAccounts().seed({
          id: SUB_ALICE,
          parentUserId: ALICE,
          revoked: false,
        });
        const gated = tradeWith(subAccounts);
        await fund(ALICE, 'USDT', '1000');

        const order = await gated.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('2'),
          price: amt('100'),
          clientOrderId: 'alice-sub-1',
          subAccountId: SUB_ALICE,
        });

        expect(order.subAccountId).toBe(SUB_ALICE);
        expect(subAccounts.lookedUp).toEqual([SUB_ALICE]);
        expect(await held(ALICE, 'USDT')).toBe('200');
        expect(matching.submitted).toHaveLength(1);
      });

      it('refuses a foreign sub-account before any hold', async () => {
        const subAccounts = new StubSubAccounts().seed({
          id: SUB_BOB,
          parentUserId: BOB,
          revoked: false,
        });
        const gated = tradeWith(subAccounts);
        await fund(ALICE, 'USDT', '1000');

        await expect(
          gated.placeOrder(principalFor(ALICE), {
            clientOrderId: 'auto-cli-2',
            marketId: btcusdt.id,
            side: 'buy',
            type: 'limit',
            qty: amt('2'),
            price: amt('100'),
            subAccountId: SUB_BOB,
          }),
        ).rejects.toMatchObject({ code: 'trade.sub_account_denied' });

        expect(await held(ALICE, 'USDT')).toBe('0');
        expect(await sql`SELECT id FROM trade.orders`).toHaveLength(0);
        expect(matching.submitted).toHaveLength(0);
      });

      it('refuses a revoked sub-account before any hold', async () => {
        const subAccounts = new StubSubAccounts().seed({
          id: SUB_ALICE,
          parentUserId: ALICE,
          revoked: true,
        });
        const gated = tradeWith(subAccounts);
        await fund(ALICE, 'USDT', '1000');

        await expect(
          gated.placeOrder(principalFor(ALICE), {
            clientOrderId: 'auto-cli-3',
            marketId: btcusdt.id,
            side: 'buy',
            type: 'limit',
            qty: amt('2'),
            price: amt('100'),
            subAccountId: SUB_ALICE,
          }),
        ).rejects.toMatchObject({ code: 'trade.sub_account_revoked' });

        expect(await held(ALICE, 'USDT')).toBe('0');
        expect(matching.submitted).toHaveLength(0);
      });

      it('fail-closes when identity is unreachable', async () => {
        const subAccounts = new StubSubAccounts();
        subAccounts.unavailable = true;
        const gated = tradeWith(subAccounts);
        await fund(ALICE, 'USDT', '1000');

        await expect(
          gated.placeOrder(principalFor(ALICE), {
            clientOrderId: 'auto-cli-4',
            marketId: btcusdt.id,
            side: 'buy',
            type: 'limit',
            qty: amt('2'),
            price: amt('100'),
            subAccountId: SUB_ALICE,
          }),
        ).rejects.toMatchObject({ code: 'trade.sub_account_unavailable' });

        expect(await held(ALICE, 'USDT')).toBe('0');
        expect(matching.submitted).toHaveLength(0);
      });

      it('default (no client) still denies any supplied subAccountId', async () => {
        // beforeEach TradeService uses NoSubAccounts — every id is unknown.
        await fund(ALICE, 'USDT', '1000');
        await expect(
          trade.placeOrder(principalFor(ALICE), {
            clientOrderId: 'auto-cli-5',
            marketId: btcusdt.id,
            side: 'buy',
            type: 'limit',
            qty: amt('2'),
            price: amt('100'),
            subAccountId: SUB_ALICE,
          }),
        ).rejects.toMatchObject({ code: 'trade.sub_account_denied' });
        expect(await held(ALICE, 'USDT')).toBe('0');
      });
    });

    it('refuses on a halted market, and holds nothing', async () => {
      await fund(ALICE, 'USDT', '1000');
      await trade.setMarketStatus(btcusdt.id, 'halted');

      await expect(rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-1')).rejects.toMatchObject({
        code: 'trade.market_not_tradable',
      });
      expect(await held(ALICE, 'USDT')).toBe('0');
      expect(matching.submitted).toHaveLength(0);
    });

    it('lets a user out of a halted market — cancelling is not gated', async () => {
      await fund(ALICE, 'USDT', '1000');
      const order = await rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-1');
      await trade.setMarketStatus(btcusdt.id, 'halted');

      const cancelled = await trade.cancelOrder(principalFor(ALICE), order.id);
      expect(cancelled.status).toBe('cancelled');
      expect(await avail(ALICE, 'USDT')).toBe('1000');
    });

    it('refuses when the kill-switch is off, and holds nothing', async () => {
      const off = new TradeService(sql, ledger, matching, perks, bus, {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: false,
      });
      await fund(ALICE, 'USDT', '1000');

      await expect(
        off.placeOrder(principalFor(ALICE), {
          clientOrderId: 'auto-cli-6',
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('2'),
          price: amt('100'),
        }),
      ).rejects.toMatchObject({ code: 'trade.spot_disabled' });

      expect(await held(ALICE, 'USDT')).toBe('0');
      expect(matching.submitted).toHaveLength(0);
    });

    /**
     * VENUE HOURS, end to end.
     *
     * `risk.test.ts` proves the predicate; this proves the ORDERING, which is the
     * money claim: a closed venue is refused before `recipes.orderHold` posts. A
     * hold taken here locks the user's balance behind a book nobody is matching
     * until the session reopens — two days, over a weekend.
     *
     * The clock is injected. With the ambient one this test would pass for the
     * wrong reason five days a week and fail on the other two.
     */
    it('refuses production listing of forex without fiat settlement rails (D-S-05)', async () => {
      await expect(
        trade.listMarket({
          symbol: 'EUR/USD-PROD',
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
          // paper omitted → production listing
        }),
      ).rejects.toMatchObject({ code: 'trade.unsettled_asset_class_listing' });

      // paper model remains legal
      const paper = await trade.listMarket({
        symbol: 'EUR/USD-PAPER',
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
      expect(paper.paper).toBe(true);
      expect(paper.assetClass).toBe('forex');
    });

    /**
     * DIRECTION:33 / D26-P0-17 — empty insurance fund → no real-money futures list.
     * Capitalisation size stays owner-open; this only proves refuse-closed when empty
     * and allow when any positive balance exists (via real topup recipe).
     */
    it('refuses active real-money futures listing when the insurance fund is empty', async () => {
      await expect(
        trade.listMarket({
          symbol: 'BTC/USDT-PERP',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          kind: 'futures',
          tickSize: amt('0.01'),
          lotSize: amt('0.0001'),
          minQty: amt('0.0001'),
          maxQty: null,
          minNotional: amt('1'),
          makerBps: 0,
          takerBps: 0,
        }),
      ).rejects.toMatchObject({ code: 'trade.insurance_fund_empty' });

      // paper + pending remain honest model paths without capitalisation
      const paper = await trade.listMarket({
        symbol: 'BTC/USDT-PERP-PAPER',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        kind: 'futures',
        tickSize: amt('0.01'),
        lotSize: amt('0.0001'),
        minQty: amt('0.0001'),
        maxQty: null,
        minNotional: amt('1'),
        makerBps: 0,
        takerBps: 0,
        paper: true,
      });
      expect(paper.kind).toBe('futures');
      expect(paper.paper).toBe(true);

      const pending = await trade.listMarket({
        symbol: 'BTC/USDT-PERP-PENDING',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        kind: 'futures',
        tickSize: amt('0.01'),
        lotSize: amt('0.0001'),
        minQty: amt('0.0001'),
        maxQty: null,
        minNotional: amt('1'),
        makerBps: 0,
        takerBps: 0,
        status: 'pending',
      });
      expect(pending.status).toBe('pending');

      // Enable-to-active must refuse the same way — listing as pending then
      // flipping status cannot bypass DIRECTION:33.
      await expect(trade.setMarketStatus(pending.id, 'active')).rejects.toMatchObject({
        code: 'trade.insurance_fund_empty',
      });
    });

    it('lists active futures once the insurance fund holds a positive balance', async () => {
      const seedUser = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const seed = amt('1');
      const pos = 'ins-list-seed';
      await ledger.post(recipes.deposit({ userId: seedUser, assetId: 'USDT', amount: seed, rail: 'test', railRef: 'ins-list-dep' }));
      await ledger.post(recipes.futuresMarginLock({ positionId: pos, userId: seedUser, assetId: 'USDT', amount: seed }));
      await ledger.post(
        recipes.futuresRealizeLoss({
          positionId: pos,
          userId: seedUser,
          assetId: 'USDT',
          fromMargin: seed,
          fromInsurance: 0n,
          lossId: pos,
        }),
      );
      await ledger.post(recipes.futuresInsuranceTopup({ topupId: pos, assetId: 'USDT', amount: seed }));

      const listed = await trade.listMarket({
        symbol: 'ETH/USDT-PERP',
        baseAsset: 'ETH',
        quoteAsset: 'USDT',
        kind: 'futures',
        tickSize: amt('0.01'),
        lotSize: amt('0.0001'),
        minQty: amt('0.0001'),
        maxQty: null,
        minNotional: amt('1'),
        makerBps: 0,
        takerBps: 0,
      });
      expect(listed.kind).toBe('futures');
      expect(listed.status).toBe('active');
      expect(listed.paper).toBe(false);
      expect(listed.futuresContractStyle).toBe('perpetual');
      expect(listed.futuresExpiryAt).toBeNull();
    });

    it('refuses dated futures listing without expiry rather than listing a perp', async () => {
      const withFixing = new TradeService(sql, ledger, matching, perks, bus, {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
        futuresEnabled: true,
        futuresSettlementFixing: 'owner-dated-fixing',
      });
      await expect(
        withFixing.listMarket({
          symbol: 'BTC/USDT:USDT-251226-NOEXP',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          kind: 'futures',
          futuresContractStyle: 'dated',
          tickSize: amt('0.01'),
          lotSize: amt('0.0001'),
          minQty: amt('0.0001'),
          maxQty: null,
          minNotional: amt('1'),
          makerBps: 0,
          takerBps: 0,
          paper: true,
        }),
      ).rejects.toMatchObject({ code: 'trade.dated_futures_expiry_required' });
    });

    it('refuses live dated futures listing when settlement fixing env is empty', async () => {
      await expect(
        trade.listMarket({
          symbol: 'BTC/USDT:USDT-251226-NOFIX',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          kind: 'futures',
          futuresContractStyle: 'dated',
          futuresExpiryAt: new Date('2026-12-26T08:00:00.000Z'),
          tickSize: amt('0.01'),
          lotSize: amt('0.0001'),
          minQty: amt('0.0001'),
          maxQty: null,
          minNotional: amt('1'),
          makerBps: 0,
          takerBps: 0,
          paper: false,
          status: 'pending',
        }),
      ).rejects.toMatchObject({ code: 'trade.dated_futures_fixing_unconfigured' });
    });

    it('lists paper dated futures with expiry and refuses place after expiry', async () => {
      const withFixing = new TradeService(sql, ledger, matching, perks, bus, {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
        futuresEnabled: true,
        futuresSettlementFixing: 'owner-dated-fixing',
        now: () => new Date('2026-12-26T09:00:00.000Z'),
      });
      const listed = await withFixing.listMarket({
        symbol: 'BTC/USDT:USDT-251226',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        kind: 'futures',
        futuresContractStyle: 'dated',
        futuresExpiryAt: new Date('2026-12-26T08:00:00.000Z'),
        tickSize: amt('0.01'),
        lotSize: amt('0.0001'),
        minQty: amt('0.0001'),
        maxQty: null,
        minNotional: amt('1'),
        makerBps: 0,
        takerBps: 0,
        paper: true,
      });
      expect(listed.kind).toBe('futures');
      expect(listed.futuresContractStyle).toBe('dated');
      expect(listed.futuresExpiryAt?.toISOString()).toBe('2026-12-26T08:00:00.000Z');

      const row = await sql<{ futures_settlement_fixing: string | null; futures_contract_style: string | null }[]>`
        SELECT futures_settlement_fixing, futures_contract_style
          FROM trade.markets WHERE id = ${listed.id}
      `;
      expect(row[0]?.futures_contract_style).toBe('dated');
      expect(row[0]?.futures_settlement_fixing).toBe('owner-dated-fixing');

      await expect(
        withFixing.placeOrder(principalFor(ALICE), {
          marketId: listed.id,
          side: 'buy',
          type: 'limit',
          qty: amt('0.01'),
          price: amt('1000'),
          clientOrderId: 'dated-expired-must-refuse',
        }),
      ).rejects.toMatchObject({ code: 'trade.dated_futures_expired' });
    });

    /**
     * trade.options refuse-closed until D26-P0-05 (SOCKET §13).
     *
     * Default service has empty TRADE_OPTIONS_SETTLEMENT_ASSET_LAW → refuse any
     * kind=options list (even with complete terms + fixing). Fixing alone must
     * not unlock. With P0-05 + fixing set, incomplete terms still refuse.
     * Complete terms list; live orders remain refused. Paper options place.
     */
    it('refuses options listing when P0-05 settlement asset law is unset', async () => {
      await expect(
        trade.listMarket({
          symbol: 'BTC/USDT:USDT-251226-90000-C',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          kind: 'options',
          tickSize: amt('0.01'),
          lotSize: amt('0.0001'),
          minQty: amt('0.0001'),
          maxQty: null,
          minNotional: amt('1'),
          makerBps: 10,
          takerBps: 20,
          optionType: 'call',
          optionStrike: amt('90000'),
          optionExpiryAt: new Date('2025-12-26T08:00:00.000Z'),
        }),
      ).rejects.toMatchObject({ code: 'trade.options_settlement_law_unset' });
    });

    it('refuses options when P0-05 is set but D7 fixing is empty', async () => {
      const withLaw = new TradeService(sql, ledger, matching, perks, bus, {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
        optionsSettlementAssetLaw: 'd26-p0-05-adr-published',
      });
      await expect(
        withLaw.listMarket({
          symbol: 'BTC/USDT:USDT-251226-NOFIX',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          kind: 'options',
          tickSize: amt('0.01'),
          lotSize: amt('0.0001'),
          minQty: amt('0.0001'),
          maxQty: null,
          minNotional: amt('1'),
          makerBps: 10,
          takerBps: 20,
          optionType: 'call',
          optionStrike: amt('90000'),
          optionExpiryAt: new Date('2025-12-26T08:00:00.000Z'),
        }),
      ).rejects.toMatchObject({ code: 'trade.options_fixing_unconfigured' });
    });

    it('refuses half-listed options even when P0-05 law + fixing are configured', async () => {
      const withLaw = new TradeService(sql, ledger, matching, perks, bus, {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
        optionsSettlementAssetLaw: 'd26-p0-05-adr-published',
        optionsSettlementFixing: 'owner-d7-opaque-id',
      });
      await expect(
        withLaw.listMarket({
          symbol: 'BTC/USDT:USDT-251226-HALF',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          kind: 'options',
          tickSize: amt('0.01'),
          lotSize: amt('0.0001'),
          minQty: amt('0.0001'),
          maxQty: null,
          minNotional: amt('1'),
          makerBps: 10,
          takerBps: 20,
          // missing optionType / strike / expiry
        }),
      ).rejects.toMatchObject({ code: 'trade.options_terms_incomplete' });
    });

    it('lists a complete live options market when P0-05 law + fixing are configured; live orders still refuse by kind', async () => {
      const withLaw = new TradeService(sql, ledger, matching, perks, bus, {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
        optionsSettlementAssetLaw: 'd26-p0-05-adr-published',
        optionsSettlementFixing: 'owner-d7-opaque-id',
      });
      const listed = await withLaw.listMarket({
        symbol: 'BTC/USDT:USDT-251226-90000-C',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        kind: 'options',
        tickSize: amt('0.01'),
        lotSize: amt('0.0001'),
        minQty: amt('0.0001'),
        maxQty: null,
        minNotional: amt('1'),
        makerBps: 10,
        takerBps: 20,
        optionType: 'call',
        optionStrike: amt('90000'),
        optionExpiryAt: new Date('2025-12-26T08:00:00.000Z'),
      });
      expect(listed.kind).toBe('options');
      expect(listed.symbol).toBe('BTC/USDT:USDT-251226-90000-C');

      // CHECK stamp is on the row even if Market domain omits terms.
      const row = await sql<{ settlement_fixing: string | null; option_type: string | null; option_strike: string | null }[]>`
        SELECT settlement_fixing, option_type, option_strike::text AS option_strike
          FROM trade.markets WHERE id = ${listed.id}
      `;
      expect(row[0]?.settlement_fixing).toBe('owner-d7-opaque-id');
      expect(row[0]?.option_type).toBe('call');
      expect(row[0]?.option_strike).toMatch(/^90000(\.0+)?$/);

      await fund(ALICE, 'USDT', '100000');
      await expect(
        withLaw.placeOrder(principalFor(ALICE), {
          marketId: listed.id,
          side: 'buy',
          type: 'limit',
          qty: amt('0.01'),
          price: amt('1000'),
          clientOrderId: 'opt-must-refuse',
        }),
      ).rejects.toMatchObject({ code: 'trade.market_kind_unsupported' });
    });

    it('paper options list without settlement law and paper placeOrder is not 501 / not kind-unsupported', async () => {
      const listed = await trade.listMarket({
        symbol: 'BTC/USDT:USDT-251226-90000-C-PAPER',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        kind: 'options',
        tickSize: amt('0.01'),
        lotSize: amt('0.0001'),
        minQty: amt('0.0001'),
        maxQty: null,
        minNotional: amt('1'),
        makerBps: 10,
        takerBps: 20,
        paper: true,
        optionType: 'call',
        optionStrike: amt('90000'),
        optionExpiryAt: new Date('2025-12-26T08:00:00.000Z'),
      });
      expect(listed.kind).toBe('options');
      expect(listed.paper).toBe(true);

      const placed = await trade.placeOrder(principalFor(ALICE), {
        marketId: listed.id,
        side: 'buy',
        type: 'limit',
        qty: amt('0.01'),
        price: amt('1000'),
        clientOrderId: 'opt-paper-place',
      });
      expect(placed.status).toBe('open');
      expect(placed.qty).toBe(amt('0.01'));
      expect(placed.lifecycleProof?.action).toBe('PLACE');
      const persistedPaperProof = await sql<Array<{ lifecycle_proof: { action?: string; decision?: string } | null }>>`
        SELECT lifecycle_proof FROM trade.orders WHERE id = ${placed.id}
      `;
      expect(persistedPaperProof[0]?.lifecycle_proof).toMatchObject({ action: 'PLACE', decision: 'ELIGIBLE' });
      expect(matching.submitted.some((s) => s.request.orderId === placed.id)).toBe(true);
    });

    it('refuses a weekend forex order and holds nothing', async () => {
      // paper=true: D-S-05 allows modelling forex; production active listing is refused.
      const eurusd = await trade.listMarket({
        symbol: 'EUR/USD',
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

      // Saturday. The listing is `active` throughout — this is the venue, not a halt.
      expect(eurusd.status).toBe('active');
      expect(eurusd.paper).toBe(true);
      const saturday = new TradeService(sql, ledger, matching, perks, bus, {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
        now: () => new Date('2026-01-10T12:00:00Z'),
      });

      await fund(ALICE, 'USD', '1000');

      await expect(
        saturday.placeOrder(principalFor(ALICE), {
          marketId: eurusd.id,
          side: 'buy',
          type: 'limit',
          qty: amt('100'),
          price: amt('1.10000'),
          clientOrderId: 'weekend-eurusd',
        }),
      ).rejects.toMatchObject({ code: 'trade.market_closed' });

      // Hours must win over clientOrderId — a weekend order without a retry key
      // is still market_closed, not trade.client_order_id_required (no hold).
      await expect(
        saturday.placeOrder(principalFor(ALICE), {
          marketId: eurusd.id,
          side: 'buy',
          type: 'limit',
          qty: amt('100'),
          price: amt('1.10000'),
        }),
      ).rejects.toMatchObject({ code: 'trade.market_closed' });

      // The three things that must all be untouched: no hold, nothing submitted,
      // and the full balance still spendable.
      expect(await held(ALICE, 'USD')).toBe('0');
      expect(await avail(ALICE, 'USD')).toBe('1000');
      expect(matching.submitted).toHaveLength(0);

      // Not even a `pending` intent row — the refusal is upstream of the row.
      const rows = await sql`SELECT id FROM trade.orders WHERE id = ${orderIdFor(ALICE, eurusd.id, 'weekend-eurusd')}`;
      expect(rows).toHaveLength(0);

      // And no ledger movement of any kind happened under the hold reason.
      expect(postsWithReason('order.hold')).toHaveLength(0);
    });

    /**
     * The same market, the same service, one clock apart. This is what makes the
     * refusal above attributable to the schedule rather than to the listing being
     * broken in some unrelated way.
     */
    it('accepts the same forex order once the session opens', async () => {
      const eurusd = await trade.listMarket({
        symbol: 'EUR/USD',
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

      // Wednesday noon UTC — inside the session on any definition.
      const wednesday = new TradeService(sql, ledger, matching, perks, bus, {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
        now: () => new Date('2026-01-14T12:00:00Z'),
      });

      await fund(ALICE, 'USD', '1000');

      const order = await wednesday.placeOrder(principalFor(ALICE), {
        marketId: eurusd.id,
        side: 'buy',
        type: 'limit',
        qty: amt('100'),
        price: amt('1.10000'),
        clientOrderId: 'midweek-eurusd',
      });

      expect(order.status).toBe('open');
      // paper markets never post real holds — schedule acceptance is the proof.
      expect(await held(ALICE, 'USD')).toBe('0');
      expect(await avail(ALICE, 'USD')).toBe('1000');
    });

    it('refuses an off-grid price and an off-grid quantity before any hold', async () => {
      await fund(ALICE, 'USDT', '1000');

      await expect(rest(ALICE, btcusdt, 'buy', '2', '100.005', 'bad-price')).rejects.toMatchObject({
        code: 'trade.invalid_price',
      });
      await expect(rest(ALICE, btcusdt, 'buy', '2.00005', '100', 'bad-qty')).rejects.toMatchObject({
        code: 'trade.invalid_qty',
      });
      await expect(rest(ALICE, btcusdt, 'buy', '0.0001', '100', 'dust')).rejects.toMatchObject({
        code: 'trade.below_min_notional',
      });

      expect(await held(ALICE, 'USDT')).toBe('0');
      expect(matching.submitted).toHaveLength(0);
    });

    it('refuses a stop order — funding one is not solved (SOCKET §13)', async () => {
      await fund(ALICE, 'USDT', '1000');
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          clientOrderId: 'auto-cli-7',
          marketId: btcusdt.id,
          side: 'buy',
          type: 'stop_limit',
          qty: amt('2'),
          price: amt('100'),
        }),
      ).rejects.toMatchObject({ code: 'trade.order_type_unsupported' });
      expect(await held(ALICE, 'USDT')).toBe('0');
    });

    it('keeps the hold when the engine is unreachable — the order may be live', async () => {
      const unreachable = new UnreachableMatching();
      const service = new TradeService(sql, ledger, unreachable, perks, bus, {
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
          clientOrderId: 'indeterminate',
        }),
      ).rejects.toThrow(/unreachable/);

      // Releasing here would be the bug: if the engine DID take the order, a
      // fill would land against money that had been given back.
      const orderId = orderIdFor(ALICE, btcusdt.id, 'indeterminate');
      const order = await service.findOrder(orderId);
      expect(order?.status).toBe('open');
      expect(await held(ALICE, 'USDT')).toBe('200');

      // Recovery: cancel. The engine answers "not live" and the hold comes back.
      await service.cancelOrder(principalFor(ALICE), orderId);
      expect(await avail(ALICE, 'USDT')).toBe('1000');
      expect(await held(ALICE, 'USDT')).toBe('0');
    });
  });

  // ── Market orders ─────────────────────────────────────────────────────────

}
