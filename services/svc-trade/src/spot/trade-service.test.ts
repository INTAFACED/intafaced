import { TradeService } from '../controls/test-admission.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { AUTH_ATTRIBUTION_MISSING } from './auth-attribution.js';
import { DROP_COPY_SOURCE_REST, type DropCopyFillWire } from './drop-copy-ingest.js';

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
      `H8a: svc-trade trade-service is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAROL = '33333333-3333-4333-8333-333333333333';

describe('H8a money suite is not skip-green', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-trade trade-service (H8a PG-hard)', () => {
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
  let dropCopySeen: DropCopyFillWire[];
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
    dropCopySeen = [];
    trade = new TradeService(sql, ledger, matching, perks, bus, {
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 150,
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      dropCopyIngest: {
        postFill: async (fill) => {
          dropCopySeen.push(fill);
        },
      },
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

  // ── The happy path ──────────────────────────────────────────────────────

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

    it('stamps session id from the signed principal onto order, fill, and ledger', async () => {
      await fund(BOB, 'BTC', '5');
      await fund(ALICE, 'USDT', '1000');

      const maker = await rest(BOB, btcusdt, 'sell', '2', '100', 'bob-auth');
      matching.scriptFills([{ makerOrderId: maker.id, makerAccountId: BOB, price: '100', qty: '2' }]);
      await rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-auth');

      const session = principalFor(ALICE).sid;
      const orderRows = await sql<Array<{ session_id: string | null; api_key_id: string | null }>>`
        SELECT session_id, api_key_id FROM trade.orders ORDER BY created_at
      `;
      expect(orderRows).toHaveLength(2);
      expect(orderRows.every((r) => r.session_id === session && r.api_key_id === null)).toBe(true);

      const fillRows = await sql<Array<{ session_id: string | null; api_key_id: string | null }>>`
        SELECT session_id, api_key_id FROM trade.fills
      `;
      expect(fillRows).toHaveLength(2);
      expect(fillRows.every((r) => r.session_id === session && r.api_key_id === null)).toBe(true);

      const fillTx = postsWithReason('trade.fill')[0];
      expect(fillTx?.meta).toMatchObject({
        makerSessionId: session,
        takerSessionId: session,
        makerApiKeyId: null,
        takerApiKeyId: null,
      });
      const holdTx = postsWithReason('order.hold')[0];
      expect(holdTx?.meta).toMatchObject({ sessionId: session, apiKeyId: null });
    });

    it('place without session or API-key id refuses — does not invent a session', async () => {
      await fund(ALICE, 'USDT', '1000');
      const bare = { ...principalFor(ALICE), sid: '', kid: undefined };
      await expect(
        trade.placeOrder(bare, {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('1'),
          price: amt('100'),
          clientOrderId: 'alice-no-auth',
        }),
      ).rejects.toMatchObject({ code: AUTH_ATTRIBUTION_MISSING });
      expect(await sql`SELECT id FROM trade.orders`).toHaveLength(0);
      expect(matching.submitted).toHaveLength(0);
    });

    it('fill without session id is not stored silently', async () => {
      const makerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const takerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      await sql`
        INSERT INTO trade.orders (
          id, user_id, market_id, side, type, price, qty, status, tif,
          hold_asset, hold_amount, fee_discount_bps
        ) VALUES
          (${makerId}, ${BOB}, ${btcusdt.id}, 'sell', 'limit', ${'100'}::numeric, ${'1'}::numeric,
           'open', 'GTC', 'BTC', ${'1'}::numeric, 0),
          (${takerId}, ${ALICE}, ${btcusdt.id}, 'buy', 'limit', ${'100'}::numeric, ${'1'}::numeric,
           'open', 'GTC', 'USDT', ${'100'}::numeric, 0)
      `;

      await expect(
        trade.settleFillEvent({
          marketId: btcusdt.id,
          makerOrderId: makerId,
          takerOrderId: takerId,
          price: '100',
          qty: '1',
          sequence: 1,
          makerAccountId: BOB,
          takerAccountId: ALICE,
        }),
      ).rejects.toMatchObject({ code: AUTH_ATTRIBUTION_MISSING });

      const fills = await sql`SELECT id FROM trade.fills`;
      expect(fills).toHaveLength(0);
      expect(postsWithReason('trade.fill')).toHaveLength(0);
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
      expect(dropCopySeen).toHaveLength(0);
    });

    it('API-key place fill hitches drop-copy as rest; never ui', async () => {
      await fund(BOB, 'BTC', '5');
      await fund(ALICE, 'USDT', '1000');
      const bobKey = { ...principalFor(BOB), kid: 'key-bob' };
      const aliceKey = { ...principalFor(ALICE), kid: 'key-alice' };
      const maker = await trade.placeOrder(bobKey, {
        marketId: btcusdt.id,
        side: 'sell',
        type: 'limit',
        qty: amt('2'),
        price: amt('100'),
        clientOrderId: 'bob-rest-dc',
      });
      matching.scriptFills([{ makerOrderId: maker.id, makerAccountId: BOB, price: '100', qty: '2' }]);
      await trade.placeOrder(aliceKey, {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('2'),
        price: amt('100'),
        clientOrderId: 'alice-rest-dc',
      });
      expect(dropCopySeen.length).toBeGreaterThan(0);
      expect(dropCopySeen.every((f) => f.source === DROP_COPY_SOURCE_REST)).toBe(true);
      expect(dropCopySeen.every((f) => String(f.source) !== 'ui')).toBe(true);
      expect(dropCopySeen.every((f) => typeof f.price === 'string' && typeof f.qty === 'string')).toBe(true);
      expect(postsWithReason('trade.fill')).toHaveLength(1);
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

  // ── Failure: the hold is refused ────────────────────────────────────────

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

  // ── Failure: cancel before any fill ─────────────────────────────────────

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

  // ── THE double-release trap ─────────────────────────────────────────

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

  // ── Retries ───────────────────────────────────────────────
});
