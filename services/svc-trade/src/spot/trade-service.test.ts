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

  describe('place → hold → fill → settle', () => {
    it('holds, matches, settles six entries, and the books close', async () => {
      await fund(BOB, 'BTC', '5');
      await fund(ALICE, 'USDT', '1000');

      const maker = await rest(BOB, btcusdt, 'sell', '2', '100', 'bob-1');
      expect(maker.status).toBe('open');
      expect(maker.lifecycleProof?.action).toBe('PLACE');
      expect(maker.lifecycleProof?.decision).toBe('ELIGIBLE');
      const persistedProof = await sql<Array<{ lifecycle_proof: { action?: string; decision?: string } | null }>>`
        SELECT lifecycle_proof FROM trade.orders WHERE id = ${maker.id}
      `;
      expect(persistedProof[0]?.lifecycle_proof).toMatchObject({ action: 'PLACE', decision: 'ELIGIBLE' });
      expect(await held(BOB, 'BTC')).toBe('2');
      expect(await avail(BOB, 'BTC')).toBe('3');

      matching.scriptFills([{ makerOrderId: maker.id, makerAccountId: BOB, price: '100', qty: '2' }]);

      const taker = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('2'),
        price: amt('100'),
        clientOrderId: 'alice-1',
      });

      expect(taker.status).toBe('filled');
      expect(formatAmount(taker.filledQty)).toBe('2');

      // Alice paid 200 USDT out of hold and received 2 BTC less a 20 bps taker fee.
      expect(await avail(ALICE, 'USDT')).toBe('800');
      expect(await held(ALICE, 'USDT')).toBe('0');
      expect(await avail(ALICE, 'BTC')).toBe('1.996');

      // Bob delivered 2 BTC out of hold and received 200 USDT less a 10 bps maker fee.
      expect(await avail(BOB, 'BTC')).toBe('3');
      expect(await held(BOB, 'BTC')).toBe('0');
      expect(await avail(BOB, 'USDT')).toBe('199.8');

      expect(await fees('BTC')).toBe('0.004');
      expect(await fees('USDT')).toBe('0.2');

      // THE BOOK CLOSES. Every asset nets to zero across every account —
      // nothing was created, nothing destroyed.
      expect(ledger.totalsByAsset()).toEqual({ BTC: '0', USDT: '0' });
      expect(ledger.reconcile()).toEqual({ ok: true });
      expect(ledger.verifyChain()).toEqual({ ok: true });
    });

    it('holds the funds BEFORE the engine ever sees the order', async () => {
      await fund(ALICE, 'USDT', '1000');

      let holdAtSubmit: string | null = null;
      matching.onSubmit = async (request) => {
        const tx = await ledger.getTxByKey(`order.hold:${request.orderId}`);
        // Read THIS order's own hold — the point is that this order is funded,
        // not that the user happens to have value held for something else.
        holdAtSubmit = tx ? await heldFor(ALICE, 'USDT', request.orderId) : null;
      };

      await rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-order');

      // This is the invariant the whole engine design rests on: svc-matching is
      // allowed to be pure precisely because it never sees an unfunded order.
      expect(holdAtSubmit).toBe('200');
    });

    it('records both legs of the match and the taker/maker fee split', async () => {
      await fund(BOB, 'BTC', '5');
      await fund(ALICE, 'USDT', '1000');

      const maker = await rest(BOB, btcusdt, 'sell', '2', '100', 'bob-1');
      matching.scriptFills([{ makerOrderId: maker.id, makerAccountId: BOB, price: '100', qty: '2' }]);
      await rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-1');

      const legs = await sql<Array<{ liquidity: string; fee_asset: string; fee_amount: string; fee_bps: string; quote_amount: string }>>`
        SELECT liquidity, fee_asset, fee_amount, fee_bps, quote_amount FROM trade.fills ORDER BY liquidity ASC
      `;
      expect(legs).toHaveLength(2);
      // Each side's fee comes out of what that side RECEIVED.
      expect(legs[0]).toMatchObject({ liquidity: 'maker', fee_asset: 'USDT' });
      expect(legs[1]).toMatchObject({ liquidity: 'taker', fee_asset: 'BTC' });
      expect(amt(legs[0]!.fee_amount)).toBe(amt('0.2'));
      expect(amt(legs[1]!.fee_amount)).toBe(amt('0.004'));
    });

    it('emits XP per filled order (§5.2 step 4)', async () => {
      await fund(BOB, 'BTC', '5');
      await fund(ALICE, 'USDT', '1000');

      const maker = await rest(BOB, btcusdt, 'sell', '2', '100', 'bob-1');
      matching.scriptFills([{ makerOrderId: maker.id, makerAccountId: BOB, price: '100', qty: '2' }]);
      await rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-1');

      const emitted = bus.emitted('xpEarned');
      expect(emitted).toHaveLength(2);
      expect(emitted.map((e) => e.payload.userId).sort()).toEqual([ALICE, BOB].sort());
      expect(emitted.every((e) => e.payload.sourceModule === 'trade')).toBe(true);
    });

    it('settles user take against house MM seed maker (marketMakerMakerFill)', async () => {
      await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: amt('10'), seedId: 'mm-wire-1' }));
      const mmOrderId = mmSeedOrderIdFor('wire-run', btcusdt.id, 'sell', 1);
      await ledger.post(recipes.marketMakerOrderHold({ orderId: mmOrderId, assetId: 'BTC', amount: amt('1') }));
      await fund(ALICE, 'USDT', '1000');

      matching.scriptFills([{ makerOrderId: mmOrderId, makerAccountId: MM_MATCHING_ACCOUNT_ID, price: '100', qty: '1' }]);
      await rest(ALICE, btcusdt, 'buy', '1', '100', 'alice-vs-mm');

      expect(postsWithReason('trade.fill.mm_maker')).toHaveLength(1);
      expect(formatAmount((await ledger.balance(marketMakerOrderHoldAccount('BTC', mmOrderId))).amount)).toBe('0');
      // maker 10 bps of 100 USDT quote → MM receives 99.9
      expect(formatAmount((await ledger.balance(marketMaker('USDT'))).amount)).toBe('99.9');
      // user received base (minus taker 20 bps of 1 BTC)
      expect(await avail(ALICE, 'BTC')).toBe('0.998');
      const legs = await sql<Array<{ liquidity: string; user_id: string }>>`
        SELECT liquidity, user_id::text FROM trade.fills ORDER BY liquidity ASC
      `;
      expect(legs).toHaveLength(2);
      expect(legs.find((l) => l.liquidity === 'taker')?.user_id).toBe(ALICE);
    });

    it('second partial take against house MM still uses marketMakerMakerFill (not user tradeFill)', async () => {
      // Regression: first fill inserts a stub trade.orders row; second match must
      // not route classic tradeFill against HOUSE_MM_USER_UUID (unfunded hold).
      await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: amt('10'), seedId: 'mm-partial-1' }));
      const mmOrderId = mmSeedOrderIdFor('partial-run', btcusdt.id, 'sell', 1);
      await ledger.post(recipes.marketMakerOrderHold({ orderId: mmOrderId, assetId: 'BTC', amount: amt('1') }));
      await fund(ALICE, 'USDT', '5000');
      await fund(BOB, 'USDT', '5000');

      matching.scriptFills([{ makerOrderId: mmOrderId, makerAccountId: MM_MATCHING_ACCOUNT_ID, price: '100', qty: '0.4' }]);
      await rest(ALICE, btcusdt, 'buy', '0.4', '100', 'alice-mm-p1');
      expect(postsWithReason('trade.fill.mm_maker')).toHaveLength(1);

      matching.scriptFills([{ makerOrderId: mmOrderId, makerAccountId: MM_MATCHING_ACCOUNT_ID, price: '100', qty: '0.6' }]);
      await rest(BOB, btcusdt, 'buy', '0.6', '100', 'bob-mm-p2');

      expect(postsWithReason('trade.fill.mm_maker')).toHaveLength(2);
      expect(postsWithReason('trade.fill')).toHaveLength(0);
      expect(formatAmount((await ledger.balance(marketMakerOrderHoldAccount('BTC', mmOrderId))).amount)).toBe('0');
      const stub = await sql<Array<{ seeded: boolean }>>`
        SELECT seeded FROM trade.orders WHERE id = ${mmOrderId}
      `;
      expect(stub[0]?.seeded).toBe(true);
    });
  });

  // ── Failure: the hold is refused ──────────────────────────────────────────

  describe('insufficient funds', () => {
    it('creates NO order row and never reaches the engine', async () => {
      await fund(ALICE, 'USDT', '10');

      await expect(rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-broke')).rejects.toBeInstanceOf(InsufficientFundsError);

      // The intent row is removed, so a refused order leaves nothing behind.
      const rows = await sql`SELECT id FROM trade.orders`;
      expect(rows).toHaveLength(0);

      // And the engine was never asked. An order the engine holds but the
      // ledger never funded is the failure this ordering exists to prevent.
      expect(matching.submitted).toHaveLength(0);

      expect(await avail(ALICE, 'USDT')).toBe('10');
      expect(await held(ALICE, 'USDT')).toBe('0');
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    it('refuses a sell the user cannot deliver', async () => {
      await fund(BOB, 'BTC', '0.5');
      await expect(rest(BOB, btcusdt, 'sell', '2', '100', 'bob-broke')).rejects.toBeInstanceOf(InsufficientFundsError);
      expect(await sql`SELECT id FROM trade.orders`).toHaveLength(0);
      expect(matching.submitted).toHaveLength(0);
    });

    it('leaves no pending row behind after a refused hold, even on retry', async () => {
      await fund(ALICE, 'USDT', '10');
      await expect(rest(ALICE, btcusdt, 'buy', '2', '100', 'same-key')).rejects.toThrow();
      await expect(rest(ALICE, btcusdt, 'buy', '2', '100', 'same-key')).rejects.toThrow();
      expect(await sql`SELECT id FROM trade.orders`).toHaveLength(0);
    });
  });

  // ── Failure: cancel before any fill ───────────────────────────────────────

  describe('cancel before fill', () => {
    it('releases the hold in full', async () => {
      await fund(ALICE, 'USDT', '1000');
      const order = await rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-1');
      expect(await held(ALICE, 'USDT')).toBe('200');

      const cancelled = await trade.cancelOrder(principalFor(ALICE), order.id);

      expect(cancelled.status).toBe('cancelled');
      expect(await avail(ALICE, 'USDT')).toBe('1000');
      expect(await held(ALICE, 'USDT')).toBe('0');
      expect(postsWithReason('order.hold.released')).toHaveLength(1);
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    it('releases a sell hold in the base asset', async () => {
      await fund(BOB, 'BTC', '5');
      const order = await rest(BOB, btcusdt, 'sell', '2', '100', 'bob-1');
      await trade.cancelOrder(principalFor(BOB), order.id);
      expect(await avail(BOB, 'BTC')).toBe('5');
      expect(await held(BOB, 'BTC')).toBe('0');
    });

    it('refuses a second cancel and does NOT release twice', async () => {
      await fund(ALICE, 'USDT', '1000');
      const order = await rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-1');
      await trade.cancelOrder(principalFor(ALICE), order.id);

      await expect(trade.cancelOrder(principalFor(ALICE), order.id)).rejects.toMatchObject({ code: 'trade.order_not_open' });

      // A redelivered `intafaced.matching.order.cancelled` takes the same path
      // and must also be a no-op — at-least-once is the only delivery there is.
      await trade.releaseOnCancelEvent(order.id);

      expect(await avail(ALICE, 'USDT')).toBe('1000');
      expect(postsWithReason('order.hold.released')).toHaveLength(1);
    });

    it("will not let one user cancel another user's order", async () => {
      await fund(ALICE, 'USDT', '1000');
      const order = await rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-1');

      await expect(trade.cancelOrder(principalFor(CAROL), order.id)).rejects.toMatchObject({ code: 'trade.order_not_found' });
      expect(await held(ALICE, 'USDT')).toBe('200');
    });

    it('mass-cancel pulls the authenticated account and leaves another owner', async () => {
      await fund(ALICE, 'USDT', '1000');
      await fund(BOB, 'USDT', '1000');
      const alice = await rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-mass');
      const bob = await rest(BOB, btcusdt, 'buy', '1', '99', 'bob-mass');

      const pulled = await trade.massCancelOrders(principalFor(ALICE), btcusdt.id);

      expect(pulled.map((o) => o.id)).toEqual([alice.id]);
      expect(pulled[0]!.status).toBe('cancelled');
      expect(matching.massCancels).toEqual([{ marketId: btcusdt.id, accountId: ALICE }]);
      expect(JSON.stringify(matching.massCancels[0])).not.toContain('sessionId');
      expect(await held(ALICE, 'USDT')).toBe('0');
      expect(await avail(ALICE, 'USDT')).toBe('1000');
      expect((await trade.getOrder(principalFor(BOB), bob.id)).status).toBe('open');
      expect(await held(BOB, 'USDT')).toBe('99');
    });

    it('mass-cancel for another principal does not pull this account', async () => {
      await fund(ALICE, 'USDT', '1000');
      const alice = await rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-keep');
      const pulled = await trade.massCancelOrders(principalFor(CAROL), btcusdt.id);
      expect(pulled).toEqual([]);
      expect(matching.massCancels).toEqual([{ marketId: btcusdt.id, accountId: CAROL }]);
      expect((await trade.getOrder(principalFor(ALICE), alice.id)).status).toBe('open');
      expect(await held(ALICE, 'USDT')).toBe('200');
    });

    it('still releases when the engine says the order is not live', async () => {
      await fund(ALICE, 'USDT', '1000');
      const order = await rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-1');
      matching.scriptCancelMiss(order.id);

      await trade.cancelOrder(principalFor(ALICE), order.id);

      // The engine not knowing the order is an answer, not a failure — and the
      // hold still has to come back, or it never does.
      expect(await avail(ALICE, 'USDT')).toBe('1000');
    });
  });

  describe('cancel/replace saga', () => {
    const replacementInput = {
      marketId: 'placeholder',
      side: 'buy' as const,
      type: 'limit',
      qty: amt('1'),
      price: amt('101'),
      clientOrderId: 'amend-1',
    };

    it('cancels and releases the original before funding the replacement', async () => {
      await fund(ALICE, 'USDT', '1000');
      const original = await rest(ALICE, btcusdt, 'buy', '2', '100', 'original-1');
      const outcome = await trade.replaceOrder(principalFor(ALICE), original.id, { ...replacementInput, marketId: btcusdt.id });

      expect(outcome).toMatchObject({ accepted: true, code: 'REPLACED', reconciliationRequired: false });
      expect(outcome.original.status).toBe('cancelled');
      expect(outcome.replacement?.status).toBe('open');
      expect(outcome.replacement?.replacementOf).toBe(original.id);
      expect(await heldFor(ALICE, 'USDT', original.id)).toBe('0');
      expect(await heldFor(ALICE, 'USDT', outcome.replacement!.id)).toBe('101');
      expect(postsWithReason('order.hold.released')).toHaveLength(1);
      expect(matching.cancelledOrders).toEqual([original.id]);
      expect(matching.submitted).toHaveLength(2);
    });

    it('returns the same replacement on an idempotent retry and refuses a conflict', async () => {
      await fund(ALICE, 'USDT', '1000');
      const original = await rest(ALICE, btcusdt, 'buy', '2', '100', 'original-2');
      const first = await trade.replaceOrder(principalFor(ALICE), original.id, { ...replacementInput, marketId: btcusdt.id });
      const second = await trade.replaceOrder(principalFor(ALICE), original.id, { ...replacementInput, marketId: btcusdt.id });
      const conflict = await trade.replaceOrder(principalFor(ALICE), original.id, {
        ...replacementInput,
        marketId: btcusdt.id,
        qty: amt('2'),
      });

      expect(second).toMatchObject({ accepted: true, idempotent: true, code: 'IDEMPOTENT_RETRY' });
      expect(second.replacement?.id).toBe(first.replacement?.id);
      expect(conflict).toMatchObject({ accepted: false, code: 'REPLACE_CONFLICT' });
      expect(matching.submitted).toHaveLength(2);
      expect(postsWithReason('order.hold.released')).toHaveLength(1);
    });

    it('refuses partial and terminal originals without cancelling or holding a replacement', async () => {
      await fund(ALICE, 'USDT', '1000');
      const partial = await rest(ALICE, btcusdt, 'buy', '2', '100', 'partial-1');
      await sql`UPDATE trade.orders SET filled_qty = 1 WHERE id = ${partial.id}`;
      const partialOutcome = await trade.replaceOrder(principalFor(ALICE), partial.id, { ...replacementInput, marketId: btcusdt.id });
      expect(partialOutcome).toMatchObject({ accepted: false, code: 'ORIGINAL_PARTIAL' });

      const terminal = await rest(ALICE, btcusdt, 'buy', '1', '100', 'terminal-1');
      await trade.cancelOrder(principalFor(ALICE), terminal.id);
      const terminalOutcome = await trade.replaceOrder(principalFor(ALICE), terminal.id, {
        ...replacementInput,
        marketId: btcusdt.id,
        clientOrderId: 'terminal-amend',
      });
      expect(terminalOutcome).toMatchObject({ accepted: false, code: 'ORIGINAL_NOT_REPLACEABLE' });
      expect(matching.cancelledOrders).toEqual([terminal.id]);
    });

    it('returns CANCEL_UNKNOWN and preserves the original hold', async () => {
      await fund(ALICE, 'USDT', '1000');
      const original = await rest(ALICE, btcusdt, 'buy', '2', '100', 'cancel-unknown');
      matching.cancel = async () => {
        throw new Error('cancel transport timed out');
      };

      const outcome = await trade.replaceOrder(principalFor(ALICE), original.id, { ...replacementInput, marketId: btcusdt.id });
      expect(outcome).toMatchObject({ accepted: false, code: 'CANCEL_UNKNOWN', reconciliationRequired: true });
      expect(outcome.original.status).toBe('recovery_required');
      expect(await heldFor(ALICE, 'USDT', original.id)).toBe('200');
      expect(matching.submitted).toHaveLength(1);
    });

    it('preserves a replacement hold on SUBMIT_UNKNOWN and never resubmits it', async () => {
      await fund(ALICE, 'USDT', '1000');
      const original = await rest(ALICE, btcusdt, 'buy', '2', '100', 'submit-unknown');
      matching.submit = async () => {
        throw new Error('submit transport timed out');
      };

      const first = await trade.replaceOrder(principalFor(ALICE), original.id, { ...replacementInput, marketId: btcusdt.id });
      const second = await trade.replaceOrder(principalFor(ALICE), original.id, { ...replacementInput, marketId: btcusdt.id });
      expect(first).toMatchObject({ accepted: false, code: 'REPLACEMENT_SUBMIT_UNKNOWN', reconciliationRequired: true });
      expect(second).toMatchObject({ accepted: false, code: 'REPLACEMENT_SUBMIT_UNKNOWN', reconciliationRequired: true, idempotent: true });
      expect(second.replacement?.id).toBe(first.replacement?.id);
      expect(await held(ALICE, 'USDT')).toBe('101');
      expect(matching.submitted).toHaveLength(2);
    });

    it('checks ownership before cancelling the original', async () => {
      await fund(ALICE, 'USDT', '1000');
      const original = await rest(ALICE, btcusdt, 'buy', '2', '100', 'owned-only');
      await expect(trade.replaceOrder(principalFor(BOB), original.id, { ...replacementInput, marketId: btcusdt.id })).rejects.toMatchObject(
        { code: 'trade.order_not_found' },
      );
      expect(matching.cancelledOrders).toHaveLength(0);
      expect(await heldFor(ALICE, 'USDT', original.id)).toBe('200');
    });

    it('refuses without lifecycle authority and leaves the live hold untouched', async () => {
      await fund(ALICE, 'USDT', '1000');
      const original = await rest(ALICE, btcusdt, 'buy', '2', '100', 'no-authority');
      const unavailable = new TradeService(sql, ledger, matching, perks, bus, { feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE });

      const outcome = await unavailable.replaceOrder(principalFor(ALICE), original.id, { ...replacementInput, marketId: btcusdt.id });
      expect(outcome).toMatchObject({ accepted: false, code: 'LIFECYCLE_REFUSED', reasonCode: 'trade.lifecycle_authority_unavailable' });
      expect(matching.cancelledOrders).toHaveLength(0);
      expect(await heldFor(ALICE, 'USDT', original.id)).toBe('200');
    });
  });

  describe('native amend', () => {
    it('qty-down same price PATCHes matching, retains priority, and releases leftover hold', async () => {
      await fund(ALICE, 'USDT', '1000');
      const original = await rest(ALICE, btcusdt, 'buy', '2', '100', 'native-retain');

      const outcome = await trade.amendOrder(principalFor(ALICE), original.id, { qty: amt('1') });

      expect(outcome).toMatchObject({
        accepted: true,
        code: 'AMENDED',
        path: 'NATIVE_AMEND',
        priority: 'retained',
        reconciliationRequired: false,
      });
      expect(outcome.order.qty).toBe(amt('1'));
      expect(outcome.order.engineVersion).toBe(2);
      expect(matching.amended).toHaveLength(1);
      expect(matching.amended[0]?.request.qty).toBe('1');
      expect(matching.amended[0]?.request.expectedVersion).toBe(1);
      expect(matching.amended[0]?.request.lifecycleProof.action).toBe('AMEND');
      expect(matching.cancelledOrders).toHaveLength(0);
      expect(matching.submitted).toHaveLength(1);
      expect(await heldFor(ALICE, 'USDT', original.id)).toBe('100');
      expect(await avail(ALICE, 'USDT')).toBe('900');
      expect(postsWithReason('order.hold.released')).toHaveLength(1);
    });

    it('side change is CANCEL_REPLACE and never PATCHes matching', async () => {
      await fund(ALICE, 'USDT', '1000');
      const original = await rest(ALICE, btcusdt, 'buy', '2', '100', 'native-side');

      const outcome = await trade.amendOrder(principalFor(ALICE), original.id, { qty: amt('1'), side: 'sell' });

      expect(outcome).toMatchObject({ accepted: false, code: 'CANCEL_REPLACE', path: 'NATIVE_AMEND', priority: null });
      expect(matching.amended).toHaveLength(0);
      expect(matching.cancelledOrders).toHaveLength(0);
      expect(await heldFor(ALICE, 'USDT', original.id)).toBe('200');
    });

    it('unknown matching outcome does not release as if cancelled', async () => {
      await fund(ALICE, 'USDT', '1000');
      const original = await rest(ALICE, btcusdt, 'buy', '2', '100', 'native-unknown');
      matching.amendScript = async () => {
        throw new Error('amend transport timed out');
      };

      const outcome = await trade.amendOrder(principalFor(ALICE), original.id, { qty: amt('1') });

      expect(outcome).toMatchObject({
        accepted: false,
        code: 'AMEND_UNKNOWN',
        reconciliationRequired: true,
      });
      expect(outcome.order.status).toBe('recovery_required');
      expect(outcome.order.recoveryReason).toBe('AMEND_UNKNOWN');
      expect(await heldFor(ALICE, 'USDT', original.id)).toBe('200');
      expect(postsWithReason('order.hold.released')).toHaveLength(0);
    });

    it('halted market refuses AMEND and leaves the live hold', async () => {
      await fund(ALICE, 'USDT', '1000');
      const original = await rest(ALICE, btcusdt, 'buy', '2', '100', 'native-halt');
      const halted: MarketLifecyclePort = {
        snapshot(market) {
          const open = READY_MARKET_LIFECYCLE.snapshot(market);
          return {
            ...open,
            state: 'HALTED',
            reasonCategory: 'OPERATOR',
            reasonCode: 'trade.market_halted',
            allowedActions: ['CANCEL', 'REDUCE', 'CLOSE'],
          };
        },
        admit(snapshot, action) {
          return decideMarketAction(snapshot, action);
        },
      };
      const haltedTrade = new TradeService(sql, ledger, matching, perks, bus, {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: halted,
        spotEnabled: true,
        marketSlippageCapBps: 150,
      });

      const outcome = await haltedTrade.amendOrder(principalFor(ALICE), original.id, { qty: amt('1') });

      expect(outcome).toMatchObject({ accepted: false, code: 'LIFECYCLE_REFUSED', reasonCode: 'trade.market_halted' });
      expect(matching.amended).toHaveLength(0);
      expect(await heldFor(ALICE, 'USDT', original.id)).toBe('200');
    });
  });

  // ── THE double-release trap ───────────────────────────────────────────────

  describe('partial fill then cancel', () => {
    it('releases only the unfilled remainder, exactly once', async () => {
      await fund(BOB, 'BTC', '10');
      await fund(ALICE, 'USDT', '2000');

      const maker = await rest(BOB, btcusdt, 'sell', '10', '100', 'bob-1');

      // Alice buys 10 @ 100 (hold 1000) but only 4 match; 6 rest.
      matching.scriptFills([{ makerOrderId: maker.id, makerAccountId: BOB, price: '100', qty: '4' }], { restRemainder: '6' });
      const order = await rest(ALICE, btcusdt, 'buy', '10', '100', 'alice-1');

      expect(order.status).toBe('open');
      expect(formatAmount(order.filledQty)).toBe('4');
      expect(await held(ALICE, 'USDT')).toBe('600');
      expect(await avail(ALICE, 'BTC')).toBe('3.992');

      await trade.cancelOrder(principalFor(ALICE), order.id);

      // 1000 held, 400 spent on the fill, 600 back. Not 1000 back, and not
      // 600 twice — this is where a double-release bug lives.
      expect(await avail(ALICE, 'USDT')).toBe('1600');
      expect(await held(ALICE, 'USDT')).toBe('0');

      const releases = postsWithReason('order.hold.released');
      expect(releases).toHaveLength(1);
      expect(releases[0]!.idempotencyKey).toBe(`order.release:${order.id}:0`);

      expect(ledger.reconcile()).toEqual({ ok: true });
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    it('a redelivered cancel event after a partial fill releases nothing more', async () => {
      await fund(BOB, 'BTC', '10');
      await fund(ALICE, 'USDT', '2000');

      const maker = await rest(BOB, btcusdt, 'sell', '10', '100', 'bob-1');
      matching.scriptFills([{ makerOrderId: maker.id, makerAccountId: BOB, price: '100', qty: '4' }], { restRemainder: '6' });
      const order = await rest(ALICE, btcusdt, 'buy', '10', '100', 'alice-1');

      await trade.cancelOrder(principalFor(ALICE), order.id);
      await trade.releaseOnCancelEvent(order.id);
      await trade.releaseOnCancelEvent(order.id);

      expect(await avail(ALICE, 'USDT')).toBe('1600');
      expect(postsWithReason('order.hold.released')).toHaveLength(1);
    });

    it('releases the remainder of an IOC order the engine cancelled for us', async () => {
      await fund(BOB, 'BTC', '10');
      await fund(ALICE, 'USDT', '2000');

      const maker = await rest(BOB, btcusdt, 'sell', '10', '100', 'bob-1');
      matching.scriptFills([{ makerOrderId: maker.id, makerAccountId: BOB, price: '100', qty: '4' }], { cancelRemainder: '6' });

      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('10'),
        price: amt('100'),
        tif: 'IOC',
        clientOrderId: 'alice-ioc',
      });

      expect(order.status).toBe('cancelled');
      expect(formatAmount(order.filledQty)).toBe('4');
      expect(await avail(ALICE, 'USDT')).toBe('1600');
      expect(await held(ALICE, 'USDT')).toBe('0');
      expect(postsWithReason('order.hold.released')).toHaveLength(1);
    });

    it('releases the hold of a resting order pulled by self-trade prevention', async () => {
      await fund(ALICE, 'USDT', '2000');
      await fund(ALICE, 'BTC', '5');

      const resting = await rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-resting');
      expect(await held(ALICE, 'USDT')).toBe('200');

      // Alice now sells into her own bid. §5.1 pulls the older resting order.
      matching.scriptSelfTradePrevention(resting.id, ALICE, '2');
      await rest(ALICE, btcusdt, 'sell', '2', '100', 'alice-aggressor');

      const pulled = await trade.getOrder(principalFor(ALICE, ['trade:read']), resting.id);
      expect(pulled.status).toBe('cancelled');
      expect(await held(ALICE, 'USDT')).toBe('0');
      expect(await avail(ALICE, 'USDT')).toBe('2000');
      // The aggressor's own base hold is untouched — it is still in the book.
      expect(await held(ALICE, 'BTC')).toBe('2');
    });
  });

  // ── Retries ───────────────────────────────────────────────────────────────

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
