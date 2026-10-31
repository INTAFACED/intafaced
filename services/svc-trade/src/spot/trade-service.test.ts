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
  type LedgerClient,
  type LedgerTx,
  type PostRequest,
} from '@intafaced/ledger-client';
import { AUTH_ATTRIBUTION_MISSING } from './auth-attribution.js';
import { DROP_COPY_SOURCE_REST, type DropCopyFillWire } from './drop-copy-ingest.js';

import { TradeError, type Market } from './types.js';
import { HOLD_UNKNOWN_IN_FLIGHT_BOUND_SECONDS, classifyHoldPostError, type HoldUnknownAlert } from './hold-outcome.js';
import { fakeOrder, presentCcxtOrder } from '../private-rest.js';
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

// #4494: scopes are explicit now - trade:write no longer implies trade:read.
const TRADE_READ = ['trade:read'] as const;

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
      // The stored value must be a JSON object, not the text of one (postgres.js stores a string bound to `::jsonb` as a JSON string).
      const persistedProof = await sql<Array<{ kind: string; action: string | null; decision: string | null }>>`
        SELECT jsonb_typeof(lifecycle_proof) AS kind, lifecycle_proof->>'action' AS action, lifecycle_proof->>'decision' AS decision
        FROM trade.orders WHERE id = ${maker.id}
      `;
      expect(persistedProof[0]).toEqual({ kind: 'object', action: 'PLACE', decision: 'ELIGIBLE' });
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
      await trade.releaseOnCancelEvent(order.id, '2');

      expect(await avail(ALICE, 'USDT')).toBe('1000');
      expect(postsWithReason('order.hold.released')).toHaveLength(1);
    });

    it('a cancel event the engine says was an expiry ends the order expired, and releases once', async () => {
      await fund(ALICE, 'USDT', '1000');
      const order = await rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-expired');
      expect(await held(ALICE, 'USDT')).toBe('200');

      // The bus can carry the expiry before the inline outcome of the order that triggered it: same status either way.
      await trade.releaseOnCancelEvent(order.id, '2', 'expired');
      await trade.releaseOnCancelEvent(order.id, '2', 'expired');

      expect(await sql`SELECT status FROM trade.orders WHERE id = ${order.id}`).toEqual([{ status: 'expired' }]);
      expect(await avail(ALICE, 'USDT')).toBe('1000');
      expect(postsWithReason('order.hold.released')).toHaveLength(1);
    });

    it('a cancel event with no reason, or another reason, stays a cancel and keeps the reason it was given', async () => {
      await fund(ALICE, 'USDT', '1000');
      const plain = await rest(ALICE, btcusdt, 'buy', '1', '100', 'alice-plain');
      const pulled = await rest(ALICE, btcusdt, 'buy', '1', '99', 'alice-stp');
      await trade.releaseOnCancelEvent(plain.id, '1');
      await trade.releaseOnCancelEvent(pulled.id, '1', 'self_trade_prevention');
      const asked = await rest(ALICE, btcusdt, 'buy', '1', '98', 'alice-asked');
      await trade.releaseOnCancelEvent(asked.id, '1', 'requested');
      expect(await sql`SELECT status, reject_code FROM trade.orders WHERE id = ${asked.id}`).toEqual([
        { status: 'cancelled', reject_code: null },
      ]);
      expect(await sql`SELECT status, reject_code FROM trade.orders WHERE id = ${plain.id}`).toEqual([
        { status: 'cancelled', reject_code: null },
      ]);
      expect(await sql`SELECT status, reject_code FROM trade.orders WHERE id = ${pulled.id}`).toEqual([
        { status: 'cancelled', reject_code: 'self_trade_prevention' },
      ]);
      expect(await avail(ALICE, 'USDT')).toBe('1000');
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
      expect((await trade.getOrder(principalFor(BOB, TRADE_READ), bob.id)).status).toBe('open');
      expect(await held(BOB, 'USDT')).toBe('99');
    });

    it('mass-cancel for another principal does not pull this account', async () => {
      await fund(ALICE, 'USDT', '1000');
      const alice = await rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-keep');
      const pulled = await trade.massCancelOrders(principalFor(CAROL), btcusdt.id);
      expect(pulled).toEqual([]);
      expect(matching.massCancels).toEqual([{ marketId: btcusdt.id, accountId: CAROL }]);
      expect((await trade.getOrder(principalFor(ALICE, TRADE_READ), alice.id)).status).toBe('open');
      expect(await held(ALICE, 'USDT')).toBe('200');
    });

    it('keeps the hold when the engine says the order is not live, and releases it past the in-flight bound', async () => {
      await fund(ALICE, 'USDT', '1000');
      const order = await rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-1');
      matching.scriptCancelMiss(order.id);

      // The engine not knowing the order is an answer, not a failure, but it may have matched in full with the fill
      // still on its way (#6874): the hold stays until the fill or the engine's cancel event says which.
      expect((await trade.cancelOrder(principalFor(ALICE), order.id)).status).toBe('open');
      expect(await held(ALICE, 'USDT')).toBe('200');

      // Nothing heard past the bound: the hold still has to come back, or it never does.
      await sql`UPDATE trade.orders SET engine_absent_since = now() - make_interval(secs => ${HOLD_UNKNOWN_IN_FLIGHT_BOUND_SECONDS + 1}) WHERE id = ${order.id}`;
      expect((await trade.cancelOrder(principalFor(ALICE), order.id)).status).toBe('cancelled');
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
      matching.onSubmit = () => {
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

    it('qty-down stores committed fill sum plus the new remaining when filled_qty is stale', async () => {
      await fund(BOB, 'BTC', '10');
      await fund(ALICE, 'USDT', '1000');
      const maker = await rest(BOB, btcusdt, 'sell', '10', '100', 'bob-stale-fill');
      const taker = await rest(ALICE, btcusdt, 'buy', '10', '100', 'alice-stale-fill');

      // Fill rows committed, tradeFill not posted, filled_qty still the
      // pre-refresh cache. settleFill rewrites that cache before the post;
      // a death between the insert and the refresh leaves the column behind.
      const post = ledger.post.bind(ledger);
      ledger.post = async (request) => {
        if (request.reason === 'trade.fill') throw new Error('died before tradeFill');
        return post(request);
      };
      const fill = {
        marketId: btcusdt.id,
        makerOrderId: maker.id,
        takerOrderId: taker.id,
        price: '100',
        qty: '4',
        sequence: 42,
      };
      await expect(trade.settleFillEvent(fill)).rejects.toThrow('died before tradeFill');
      ledger.post = post;
      await sql`
        UPDATE trade.orders
           SET filled_qty = 0
         WHERE id IN (${maker.id}, ${taker.id})
      `;

      const [sumRow] = await sql<Array<{ qty: string }>>`
        SELECT COALESCE(SUM(qty), 0)::text AS qty
          FROM trade.fills
         WHERE order_id = ${taker.id}
      `;
      const committedFillQty = amt(sumRow?.qty ?? '0');
      expect(formatAmount(committedFillQty)).toBe('4');
      expect(postsWithReason('trade.fill')).toHaveLength(0);

      const outcome = await trade.amendOrder(principalFor(ALICE), taker.id, { qty: amt('1') });

      expect(outcome).toMatchObject({ accepted: true, code: 'AMENDED' });
      expect(formatAmount(outcome.order.qty)).toBe(formatAmount(committedFillQty + amt('1')));
      const [amendEvent] = await sql<Array<{ quantity: string }>>`
        SELECT quantity::text AS quantity
          FROM trade.order_events
         WHERE order_id = ${taker.id}
           AND kind = 'amend'
      `;
      expect(formatAmount(amt(amendEvent?.quantity ?? '0'))).toBe('5');

      await trade.settleFillEvent(fill);

      const settled = await trade.getOrder(principalFor(ALICE, ['trade:read']), taker.id);
      expect(settled.filledQty <= settled.qty).toBe(true);
      expect(formatAmount(settled.filledQty)).toBe('4');
      expect(postsWithReason('trade.fill')).toHaveLength(1);
      expect(await heldFor(ALICE, 'USDT', taker.id)).toBe('100');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('does not pay a qty-down again when an unsettled fill leaves the hold pot above the stale remainder', async () => {
      await fund(BOB, 'BTC', '10');
      await fund(ALICE, 'USDT', '1000');
      const maker = await rest(BOB, btcusdt, 'sell', '4', '100', 'bob-unsettled-release');
      const taker = await rest(ALICE, btcusdt, 'buy', '4', '100', 'alice-unsettled-release');
      expect(await heldFor(ALICE, 'USDT', taker.id)).toBe('400');
      expect(await avail(ALICE, 'USDT')).toBe('600');

      // Fill row lands, tradeFill does not draw the hold. remainingHold already
      // subtracts that 200. The qty-down below is only 100, so the pot stays
      // above the stale remainder after the versioned release.
      const post = ledger.post.bind(ledger);
      ledger.post = async (request) => {
        if (request.reason === 'trade.fill') throw new Error('died before tradeFill');
        return post(request);
      };
      const fill = {
        marketId: btcusdt.id,
        makerOrderId: maker.id,
        takerOrderId: taker.id,
        price: '100',
        qty: '2',
        sequence: 77,
      };
      await expect(trade.settleFillEvent(fill)).rejects.toThrow('died before tradeFill');
      ledger.post = post;
      expect(postsWithReason('trade.fill')).toHaveLength(0);
      expect(await heldFor(ALICE, 'USDT', taker.id)).toBe('400');

      const versionKey = `order.release:${taker.id}:2`;
      ledger.post = async (request) => {
        const posted = await post(request);
        if (request.idempotencyKey === versionKey) throw new Error('crash after versioned release committed');
        return posted;
      };
      await expect(trade.amendOrder(principalFor(ALICE), taker.id, { qty: amt('1') })).rejects.toThrow(
        'crash after versioned release committed',
      );
      ledger.post = post;

      // 100 is already back. Pot 300 is still above the stale remainder 200
      // (hold 400 − unsettled fill 200 − amend_released 0).
      expect(await heldFor(ALICE, 'USDT', taker.id)).toBe('300');
      expect(await avail(ALICE, 'USDT')).toBe('700');

      await trade.cancelOrder(principalFor(ALICE), taker.id);

      // Cancel returns the other 100 and leaves the unsettled 200 for tradeFill.
      // Sequence 0 must not contain the 100 already posted under the amend version.
      expect(await avail(ALICE, 'USDT')).toBe('800');
      expect(await heldFor(ALICE, 'USDT', taker.id)).toBe('200');
      const releases = postsWithReason('order.hold.released');
      expect(releases.map((tx) => tx.idempotencyKey).sort()).toEqual([`order.release:${taker.id}:0`, versionKey].sort());
      const terminal = releases.find((tx) => tx.idempotencyKey === `order.release:${taker.id}:0`);
      const terminalAmount = terminal?.entries.find((entry) => entry.direction === 'credit')?.amount;
      expect(formatAmount(terminalAmount ?? 0n)).toBe('100');
      const versioned = releases.find((tx) => tx.idempotencyKey === versionKey);
      const versionedAmount = versioned?.entries.find((entry) => entry.direction === 'credit')?.amount;
      expect(formatAmount(versionedAmount ?? 0n)).toBe('100');
      expect(postsWithReason('trade.fill')).toHaveLength(0);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('a cancel that crashes after the sequence-0 release posted retries with the same amount', async () => {
      await fund(BOB, 'BTC', '10');
      await fund(ALICE, 'USDT', '1000');
      const maker = await rest(BOB, btcusdt, 'sell', '4', '100', 'bob-retry-key');
      const taker = await rest(ALICE, btcusdt, 'buy', '4', '100', 'alice-retry-key');

      // Unsettled fill of 1 (100 consumed): remainder 300, pot 400.
      const post = ledger.post.bind(ledger);
      ledger.post = async (request) => {
        if (request.reason === 'trade.fill') throw new Error('died before tradeFill');
        return post(request);
      };
      await expect(
        trade.settleFillEvent({
          marketId: btcusdt.id,
          makerOrderId: maker.id,
          takerOrderId: taker.id,
          price: '100',
          qty: '1',
          sequence: 88,
        }),
      ).rejects.toThrow('died before tradeFill');

      const terminalKey = `order.release:${taker.id}:0`;
      ledger.post = async (request) => {
        const posted = await post(request);
        if (request.idempotencyKey === terminalKey) throw new Error('crash after terminal release committed');
        return posted;
      };
      await expect(trade.cancelOrder(principalFor(ALICE), taker.id)).rejects.toThrow('crash after terminal release committed');
      ledger.post = post;

      // Pot is now 100 (the unsettled fill). The retry must reuse the booked key, not re-amount it.
      await trade.cancelOrder(principalFor(ALICE), taker.id);

      const order = await trade.getOrder(principalFor(ALICE, ['trade:read']), taker.id);
      expect(order.status).toBe('cancelled');
      expect(postsWithReason('order.hold.released').filter((tx) => tx.idempotencyKey === terminalKey)).toHaveLength(1);
      expect(await heldFor(ALICE, 'USDT', taker.id)).toBe('100');
      expect(ledger.reconcile()).toEqual({ ok: true });
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
      await trade.releaseOnCancelEvent(order.id, '6');
      await trade.releaseOnCancelEvent(order.id, '6');

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

    it('a cancel event that arrives before its fill keeps the hold, and the fill still settles', async () => {
      // Seen in the running app (J-cex-spot-01 step 8): an IOC sell partly filled a resting buy. The engine
      // published the fill and the remainder's cancel together; the cancel consumer released the whole sell
      // hold first, the fill's tradeFill then found an empty hold, and the buyer's order stayed open with
      // its USDT held and no BTC. Both orders rest here (the stub does not match), and the two engine
      // events are delivered by hand in the order that broke.
      await fund(ALICE, 'USDT', '1000');
      await fund(BOB, 'BTC', '10');
      const buy = await rest(ALICE, btcusdt, 'buy', '4', '100', 'alice-bid');
      const sell = await rest(BOB, btcusdt, 'sell', '10', '100', 'bob-sell');
      expect(await heldFor(BOB, 'BTC', sell.id)).toBe('10');

      // The engine matched 4 and cancelled the other 6; the cancel is delivered first.
      await expect(trade.releaseOnCancelEvent(sell.id, '6')).rejects.toMatchObject({ code: 'trade.cancel_ahead_of_fill' });
      expect(await heldFor(BOB, 'BTC', sell.id)).toBe('10');
      expect(postsWithReason('order.hold.released')).toHaveLength(0);

      await trade.settleFillEvent({
        marketId: btcusdt.id,
        makerOrderId: buy.id,
        takerOrderId: sell.id,
        price: '100',
        qty: '4',
        sequence: 1,
        makerAccountId: ALICE,
        takerAccountId: BOB,
      });
      // The redelivered cancel now releases only what did not fill.
      await trade.releaseOnCancelEvent(sell.id, '6');

      expect(await heldFor(BOB, 'BTC', sell.id)).toBe('0');
      expect(await avail(BOB, 'BTC')).toBe('6');
      expect(await held(ALICE, 'USDT')).toBe('0');
      expect(await avail(ALICE, 'USDT')).toBe('600');
      expect(postsWithReason('trade.fill')).toHaveLength(1);
      expect((await trade.getOrder(principalFor(BOB, ['trade:read']), sell.id)).status).toBe('cancelled');
      expect((await trade.getOrder(principalFor(ALICE, ['trade:read']), buy.id)).status).toBe('filled');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('a cancel event ahead of its fill also keeps the hold of an order waiting on recovery', async () => {
      await fund(BOB, 'BTC', '10');
      const sell = await rest(BOB, btcusdt, 'sell', '10', '100', 'bob-recovery');
      await sql`UPDATE trade.orders SET status = 'recovery_required', recovery_reason = 'SUBMIT_UNKNOWN', reconciliation_key = ${'reconcile:' + sell.id} WHERE id = ${sell.id}`;
      await expect(trade.releaseOnCancelEvent(sell.id, '6')).rejects.toMatchObject({ code: 'trade.cancel_ahead_of_fill' });
      expect(await heldFor(BOB, 'BTC', sell.id)).toBe('10');
      expect(postsWithReason('order.hold.released')).toHaveLength(0);
    });

    it('a cancel event with nothing filled releases the whole hold, as before', async () => {
      await fund(BOB, 'BTC', '10');
      const sell = await rest(BOB, btcusdt, 'sell', '10', '100', 'bob-sell');
      await trade.releaseOnCancelEvent(sell.id, '10');
      expect(await avail(BOB, 'BTC')).toBe('10');
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

  // Paper rows stay at hold 0. They are not a second book and not a funded hold.
  describe('paper orders are not live fills', () => {
    const grid = {
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      tickSize: amt('0.01'),
      lotSize: amt('0.0001'),
      minQty: amt('0.0001'),
      maxQty: amt('1000'),
      minNotional: amt('1'),
      makerBps: 10,
      takerBps: 20,
    };

    async function fillCount(): Promise<string> {
      const rows = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.fills`;
      return rows[0]?.n ?? '0';
    }

    it('inserts a paper option limit at hold 0 and does not call matching.submit', async () => {
      const paper = await trade.listMarket({
        ...grid,
        symbol: 'BTC/USDT-OPT-PAPER',
        kind: 'options',
        optionType: 'call',
        optionStrike: amt('100'),
        optionExpiryAt: new Date('2027-06-01T00:00:00.000Z'),
        paper: true,
      });
      expect(paper.paper).toBe(true);

      const maker = await rest(BOB, paper, 'sell', '1', '10', 'bob-paper-opt');
      const taker = await rest(ALICE, paper, 'buy', '1', '10', 'alice-paper-opt');

      expect(matching.submitted).toEqual([]);
      expect(maker.status).toBe('open');
      expect(taker.status).toBe('open');
      expect(maker.holdAmount).toBe(0n);
      expect(taker.holdAmount).toBe(0n);
      expect(maker.price).toBe(amt('10'));
      expect(maker.protectionPrice).toBeNull();
      expect(taker.protectionPrice).toBeNull();
      expect(postsWithReason('order.hold')).toHaveLength(0);
      expect(postsWithReason('trade.fill')).toHaveLength(0);
      expect(ledger.journal()).toEqual([]);
      expect(await heldFor(BOB, 'BTC', maker.id)).toBe('0');
      expect(await heldFor(ALICE, 'USDT', taker.id)).toBe('0');
      // The paper insert path stores the lifecycle proof as a JSON object too, not the text of one.
      const stored = await sql<Array<{ kind: string; action: string | null }>>`
        SELECT jsonb_typeof(lifecycle_proof) AS kind, lifecycle_proof->>'action' AS action FROM trade.orders WHERE id = ${maker.id}
      `;
      expect(stored[0]).toEqual({ kind: 'object', action: 'PLACE' });
    });

    it('refuses a paper fill before trade.fills and before recipes.tradeFill', async () => {
      const paper = await trade.listMarket({
        ...grid,
        symbol: 'BTC/USDT-OPT-PAPER',
        kind: 'options',
        optionType: 'call',
        optionStrike: amt('100'),
        optionExpiryAt: new Date('2027-06-01T00:00:00.000Z'),
        paper: true,
      });
      const maker = await rest(BOB, paper, 'sell', '1', '10', 'bob-paper-fill');
      const taker = await rest(ALICE, paper, 'buy', '1', '10', 'alice-paper-fill');

      let caught: unknown;
      try {
        await trade.settleFillEvent({
          marketId: paper.id,
          makerOrderId: maker.id,
          takerOrderId: taker.id,
          price: '10',
          qty: '1',
          sequence: 1,
          makerAccountId: BOB,
          takerAccountId: ALICE,
        });
      } catch (err) {
        caught = err;
      }

      expect(await fillCount()).toBe('0');
      expect(postsWithReason('trade.fill')).toHaveLength(0);
      expect(postsWithReason('order.hold')).toHaveLength(0);
      expect(ledger.journal()).toEqual([]);
      expect(caught).toBeInstanceOf(TradeError);
      expect((caught as TradeError).code).toBe('trade.paper_fill_refused');
      const makerAfter = await trade.getOrder(principalFor(BOB, ['trade:read']), maker.id);
      const takerAfter = await trade.getOrder(principalFor(ALICE, ['trade:read']), taker.id);
      expect(makerAfter.filledQty).toBe(0n);
      expect(takerAfter.filledQty).toBe(0n);
      expect(makerAfter.holdAmount).toBe(0n);
      expect(takerAfter.holdAmount).toBe(0n);
    });

    it('refuses a paper spot fill the same way', async () => {
      const paper = await trade.listMarket({
        ...grid,
        symbol: 'BTC/USDT-PAPER',
        paper: true,
      });
      const maker = await rest(BOB, paper, 'sell', '1', '10', 'bob-paper-spot');
      const taker = await rest(ALICE, paper, 'buy', '1', '10', 'alice-paper-spot');

      let caught: unknown;
      try {
        await trade.settleFillEvent({
          marketId: paper.id,
          makerOrderId: maker.id,
          takerOrderId: taker.id,
          price: '10',
          qty: '1',
          sequence: 1,
          makerAccountId: BOB,
          takerAccountId: ALICE,
        });
      } catch (err) {
        caught = err;
      }

      expect(await fillCount()).toBe('0');
      expect(postsWithReason('trade.fill')).toHaveLength(0);
      expect(caught).toBeInstanceOf(TradeError);
      expect((caught as TradeError).code).toBe('trade.paper_fill_refused');
    });

    it('does not throw trade.hold_uncovered when a paper order never filled', async () => {
      const paper = await trade.listMarket({
        ...grid,
        symbol: 'BTC/USDT-OPT-PAPER',
        kind: 'options',
        optionType: 'call',
        optionStrike: amt('100'),
        optionExpiryAt: new Date('2027-06-01T00:00:00.000Z'),
        paper: true,
      });
      const maker = await rest(BOB, paper, 'sell', '1', '10', 'bob-paper-cancel');
      const taker = await rest(ALICE, paper, 'buy', '1', '10', 'alice-paper-cancel');

      // A fill event must not leave a phantom trade.fills row that later
      // makes consumed > the zero hold. Swallow the refuse; the cancel is
      // what used to throw trade.hold_uncovered.
      await trade
        .settleFillEvent({
          marketId: paper.id,
          makerOrderId: maker.id,
          takerOrderId: taker.id,
          price: '10',
          qty: '1',
          sequence: 1,
          makerAccountId: BOB,
          takerAccountId: ALICE,
        })
        .catch(() => undefined);

      const cancelled = await trade.cancelOrder(principalFor(BOB), maker.id);
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.filledQty).toBe(0n);
      expect(cancelled.holdAmount).toBe(0n);

      await trade.releaseOnCancelEvent(taker.id, '1');
      const takerAfter = await trade.getOrder(principalFor(ALICE, ['trade:read']), taker.id);
      expect(takerAfter.status).toBe('cancelled');
      expect(takerAfter.filledQty).toBe(0n);
      expect(takerAfter.holdAmount).toBe(0n);
      expect(await fillCount()).toBe('0');
      expect(postsWithReason('trade.fill')).toHaveLength(0);
      expect(postsWithReason('order.hold')).toHaveLength(0);
      expect(postsWithReason('order.hold.released')).toHaveLength(0);
      expect(ledger.journal()).toEqual([]);
    });
  });

  // ── TRD-0540: lost order.hold reply ───────────────────────────────────────

  describe('lost order.hold reply', () => {
    function lostConnection(): Error {
      return Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' });
    }

    function neverSent(): Error {
      return Object.assign(new Error('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4001'), { code: 'ECONNREFUSED' }),
      });
    }

    function holdLedger(
      inner: MemoryLedger,
      hooks: {
        onHoldPost?: (booked: () => Promise<LedgerTx>) => Promise<LedgerTx>;
        onReadKey?: (key: string) => Promise<LedgerTx | null>;
      },
    ): LedgerClient {
      return {
        post: (req: PostRequest) => {
          if (req.reason === 'order.hold' && hooks.onHoldPost) return hooks.onHoldPost(() => inner.post(req));
          return inner.post(req);
        },
        balance: (ref) => inner.balance(ref),
        balances: (ownerType, ownerId) => inner.balances(ownerType, ownerId),
        getTx: (id) => inner.getTx(id),
        getTxByKey: (key) => (hooks.onReadKey ? hooks.onReadKey(key) : inner.getTxByKey(key)),
      };
    }

    function serviceFor(client: LedgerClient, alerts: HoldUnknownAlert[], overrides: { spotEnabled?: boolean } = {}) {
      return new TradeService(sql, client, matching, perks, bus, {
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: overrides.spotEnabled ?? true,
        marketSlippageCapBps: 150,
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        onHoldUnknownAlert: (alert) => alerts.push(alert),
      });
    }

    const limitBuy = (clientOrderId: string, tif?: 'GTC' | 'IOC' | 'FOK') => ({
      marketId: btcusdt.id,
      side: 'buy' as const,
      type: 'limit' as const,
      qty: amt('0.1'),
      price: amt('100'),
      clientOrderId,
      ...(tif ? { tif } : {}),
    });

    async function fundInner(inner: MemoryLedger, amount = '5000') {
      await inner.post(
        recipes.deposit({
          userId: ALICE,
          assetId: 'USDT',
          amount: amt(amount),
          rail: 'test',
          railRef: `hold-unknown:${amount}:${Math.random()}`,
        }),
      );
    }

    it('timeout after the hold is booked keeps the funds and opens the order', async () => {
      const inner = new MemoryLedger();
      await fundInner(inner);
      const alerts: HoldUnknownAlert[] = [];
      const svc = serviceFor(
        holdLedger(inner, {
          onHoldPost: async (book) => {
            await book();
            throw lostConnection();
          },
        }),
        alerts,
      );
      matching.script1((req, next) => restsInFull(req, next()));

      const order = await svc.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('0.1'),
        price: amt('100'),
        clientOrderId: 'timeout-after',
      });

      expect(order.status).toBe('open');
      expect(await sql`SELECT status FROM trade.orders WHERE id = ${order.id}`).toEqual([{ status: 'open' }]);
      expect(formatAmount((await inner.balance(orderHoldAccount(ALICE, 'USDT', order.id))).amount)).toBe('10');
      expect(inner.journal().filter((tx) => tx.reason === 'order.hold')).toHaveLength(1);
      expect(matching.submitted).toHaveLength(1);
      expect(alerts).toEqual([]);
    });

    it('keeps the row when a hold commits after the read said absent, then the sweep books it', async () => {
      const inner = new MemoryLedger();
      await fundInner(inner);
      let reads = 0;
      const alerts: HoldUnknownAlert[] = [];
      const svc = serviceFor(
        holdLedger(inner, {
          onHoldPost: async () => {
            throw lostConnection();
          },
          onReadKey: async (key) => {
            reads += 1;
            if (reads === 1) return null;
            return inner.getTxByKey(key);
          },
        }),
        alerts,
      );

      await expect(svc.placeOrder(principalFor(ALICE), limitBuy('late-commit'))).rejects.toThrow(/wait \d+ seconds/);

      const stuck = await sql<Array<{ id: string; status: string }>>`
        SELECT id, status::text FROM trade.orders WHERE client_order_id = 'late-commit'
      `;
      expect(stuck).toEqual([{ id: stuck[0]!.id, status: 'hold_unknown' }]);
      expect(formatAmount((await inner.balance(orderHoldAccount(ALICE, 'USDT', stuck[0]!.id))).amount)).toBe('0');
      expect(inner.journal().filter((tx) => tx.reason === 'order.hold')).toHaveLength(0);
      expect(inner.journal().filter((tx) => tx.reason === 'order.hold.released')).toHaveLength(0);
      expect(matching.submitted).toHaveLength(0);

      await inner.post(recipes.orderHold({ orderId: stuck[0]!.id, userId: ALICE, assetId: 'USDT', amount: amt('10') }));
      matching.script1((req, next) => restsInFull(req, next()));
      const swept = await svc.sweepHoldUnknown();

      expect(swept.booked).toEqual([stuck[0]!.id]);
      expect(await sql`SELECT status FROM trade.orders WHERE id = ${stuck[0]!.id}`).toEqual([{ status: 'open' }]);
      expect(formatAmount((await inner.balance(orderHoldAccount(ALICE, 'USDT', stuck[0]!.id))).amount)).toBe('10');
      expect(inner.journal().filter((tx) => tx.reason === 'order.hold')).toHaveLength(1);
      expect(inner.journal().filter((tx) => tx.reason === 'order.hold.released')).toHaveLength(0);
      expect(matching.submitted).toHaveLength(1);
    });

    it('a definite refusal still deletes the pending row', async () => {
      const inner = new MemoryLedger();
      await fundInner(inner, '1');
      const alerts: HoldUnknownAlert[] = [];
      const svc = serviceFor(holdLedger(inner, {}), alerts);

      await expect(
        svc.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('2'),
          price: amt('100'),
          clientOrderId: 'refused',
        }),
      ).rejects.toBeInstanceOf(InsufficientFundsError);

      expect(await sql`SELECT id FROM trade.orders`).toHaveLength(0);
      expect(await sql`SELECT id FROM trade.orders WHERE status = 'hold_unknown'`).toHaveLength(0);
      expect(matching.submitted).toHaveLength(0);
      expect(alerts).toEqual([]);
    });

    it('a ledger timeout leaves hold_unknown and the same clientOrderId posts the hold once', async () => {
      const inner = new MemoryLedger();
      await fundInner(inner);
      let attempts = 0;
      const alerts: HoldUnknownAlert[] = [];
      const svc = serviceFor(
        holdLedger(inner, {
          onHoldPost: async (book) => {
            attempts += 1;
            if (attempts === 1) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
            return book();
          },
        }),
        alerts,
      );
      matching.script1((req, next) => restsInFull(req, next()));

      await expect(svc.placeOrder(principalFor(ALICE), limitBuy('ledger-timeout'))).rejects.toMatchObject({
        code: 'trade.hold_unknown',
      });

      const stuck = await sql<Array<{ id: string; status: string }>>`
        SELECT id, status::text FROM trade.orders WHERE client_order_id = 'ledger-timeout'
      `;
      expect(stuck).toEqual([{ id: stuck[0]!.id, status: 'hold_unknown' }]);
      expect(inner.journal().filter((tx) => tx.reason === 'order.hold')).toHaveLength(0);
      expect(classifyHoldPostError(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toBe('unknown');

      const retried = await svc.placeOrder(principalFor(ALICE), limitBuy('ledger-timeout'));
      expect(retried.id).toBe(stuck[0]!.id);
      expect(retried.status).toBe('open');
      expect(formatAmount((await inner.balance(orderHoldAccount(ALICE, 'USDT', retried.id))).amount)).toBe('10');
      expect(inner.journal().filter((tx) => tx.reason === 'order.hold')).toHaveLength(1);
      expect(matching.submitted).toHaveLength(1);

      const again = await svc.placeOrder(principalFor(ALICE), limitBuy('ledger-timeout'));
      expect(again.id).toBe(retried.id);
      expect(again.status).toBe('open');
      expect(inner.journal().filter((tx) => tx.reason === 'order.hold')).toHaveLength(1);
      expect(attempts).toBe(2);
      expect(alerts.some((alert) => alert.orderId === retried.id && alert.resolution === 'still_unknown')).toBe(true);
    });

    it('retries the same clientOrderId once the hold key can be read', async () => {
      const inner = new MemoryLedger();
      await fundInner(inner);
      let reads = 0;
      const alerts: HoldUnknownAlert[] = [];
      const svc = serviceFor(
        holdLedger(inner, {
          onHoldPost: async (book) => {
            await book();
            throw lostConnection();
          },
          onReadKey: async (key) => {
            reads += 1;
            if (reads === 1) throw lostConnection();
            return inner.getTxByKey(key);
          },
        }),
        alerts,
      );
      matching.script1((req, next) => restsInFull(req, next()));

      await expect(
        svc.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('0.1'),
          price: amt('100'),
          clientOrderId: 'same-key',
        }),
      ).rejects.toMatchObject({ code: 'trade.hold_unknown' });

      const stuck = await sql<Array<{ id: string; status: string }>>`
        SELECT id, status FROM trade.orders WHERE client_order_id = 'same-key'
      `;
      expect(stuck).toEqual([{ id: stuck[0]!.id, status: 'hold_unknown' }]);
      expect(formatAmount((await inner.balance(orderHoldAccount(ALICE, 'USDT', stuck[0]!.id))).amount)).toBe('10');
      expect(matching.submitted).toHaveLength(0);

      const retried = await svc.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('0.1'),
        price: amt('100'),
        clientOrderId: 'same-key',
      });

      expect(retried.id).toBe(stuck[0]!.id);
      expect(retried.status).toBe('open');
      expect(inner.journal().filter((tx) => tx.reason === 'order.hold')).toHaveLength(1);
      expect(matching.submitted).toHaveLength(1);
      expect(alerts.some((alert) => alert.resolution === 'still_unknown' && alert.orderId === retried.id)).toBe(true);
    });

    it('sweep recovers a booked hold and deletes an unfunded intent', async () => {
      const inner = new MemoryLedger();
      await fundInner(inner);
      let reads = 0;
      const alerts: HoldUnknownAlert[] = [];
      const svc = serviceFor(
        holdLedger(inner, {
          onHoldPost: async (book) => {
            await book();
            throw lostConnection();
          },
          onReadKey: async (key) => {
            reads += 1;
            if (reads === 1) throw lostConnection();
            return inner.getTxByKey(key);
          },
        }),
        alerts,
      );

      await expect(
        svc.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('0.1'),
          price: amt('100'),
          clientOrderId: 'sweep-booked',
        }),
      ).rejects.toMatchObject({ code: 'trade.hold_unknown' });

      matching.script1((req, next) => restsInFull(req, next()));
      const recovered = await svc.sweepHoldUnknown();
      expect(recovered.booked).toHaveLength(1);
      expect(recovered.stillUnknown).toEqual([]);
      expect(recovered.alerts.some((alert) => alert.resolution === 'booked')).toBe(true);
      const open = await sql<Array<{ status: string }>>`SELECT status FROM trade.orders WHERE client_order_id = 'sweep-booked'`;
      expect(open).toEqual([{ status: 'open' }]);
      expect(inner.journal().filter((tx) => tx.reason === 'order.hold')).toHaveLength(1);
      expect(matching.submitted).toHaveLength(1);

      const absentInner = new MemoryLedger();
      await fundInner(absentInner);
      let absentReads = 0;
      const absentAlerts: HoldUnknownAlert[] = [];
      const absentSvc = serviceFor(
        holdLedger(absentInner, {
          onHoldPost: async () => {
            throw lostConnection();
          },
          onReadKey: async (key) => {
            absentReads += 1;
            if (absentReads === 1) throw lostConnection();
            return absentInner.getTxByKey(key);
          },
        }),
        absentAlerts,
      );
      await expect(
        absentSvc.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('0.1'),
          price: amt('100'),
          clientOrderId: 'sweep-absent',
        }),
      ).rejects.toMatchObject({ code: 'trade.hold_unknown' });

      const kept = await absentSvc.sweepHoldUnknown();
      expect(kept.absent).toHaveLength(0);
      expect(kept.stillUnknown).toHaveLength(1);
      const stuck = await sql<Array<{ id: string; status: string }>>`
        SELECT id, status::text FROM trade.orders WHERE client_order_id = 'sweep-absent'
      `;
      expect(stuck).toEqual([{ id: stuck[0]!.id, status: 'hold_unknown' }]);
      expect(formatAmount((await absentInner.balance(orderHoldAccount(ALICE, 'USDT', stuck[0]!.id))).amount)).toBe('0');
      expect(absentInner.journal().filter((tx) => tx.reason === 'order.hold')).toHaveLength(0);
      expect(absentInner.journal().filter((tx) => tx.reason === 'order.hold.released')).toHaveLength(0);
      expect(matching.submitted).toHaveLength(1);

      await sql`
        UPDATE trade.orders
           SET updated_at = now() - make_interval(secs => ${HOLD_UNKNOWN_IN_FLIGHT_BOUND_SECONDS + 1})
         WHERE id = ${stuck[0]!.id}
      `;
      const swept = await absentSvc.sweepHoldUnknown();
      expect(swept.absent).toEqual([stuck[0]!.id]);
      expect(await sql`SELECT id FROM trade.orders WHERE client_order_id = 'sweep-absent'`).toHaveLength(0);
      expect(absentInner.journal().filter((tx) => tx.reason === 'order.hold')).toHaveLength(0);
      expect(absentInner.journal().filter((tx) => tx.reason === 'order.hold.released')).toHaveLength(0);
      expect(matching.submitted).toHaveLength(1);
    });

    it('cancel on hold_unknown follows the read: unknown, absent inside the bound, absent past it, and present', async () => {
      const unknownInner = new MemoryLedger();
      await fundInner(unknownInner);
      const unknownSvc = serviceFor(
        holdLedger(unknownInner, {
          onHoldPost: async (book) => {
            await book();
            throw lostConnection();
          },
          onReadKey: async () => {
            throw lostConnection();
          },
        }),
        [],
      );
      await expect(unknownSvc.placeOrder(principalFor(ALICE), limitBuy('cancel-unknown'))).rejects.toMatchObject({
        code: 'trade.hold_unknown',
      });
      const unknownRow = await sql<Array<{ id: string }>>`SELECT id FROM trade.orders WHERE client_order_id = 'cancel-unknown'`;
      await expect(unknownSvc.cancelOrder(principalFor(ALICE), unknownRow[0]!.id)).rejects.toMatchObject({
        code: 'trade.hold_unknown',
      });
      expect(await sql`SELECT status FROM trade.orders WHERE id = ${unknownRow[0]!.id}`).toEqual([{ status: 'hold_unknown' }]);
      expect(formatAmount((await unknownInner.balance(orderHoldAccount(ALICE, 'USDT', unknownRow[0]!.id))).amount)).toBe('10');
      expect(unknownInner.journal().filter((tx) => tx.reason === 'order.hold')).toHaveLength(1);
      expect(unknownInner.journal().filter((tx) => tx.reason === 'order.hold.released')).toHaveLength(0);
      expect(matching.submitted).toHaveLength(0);
      expect(matching.cancelledOrders).toHaveLength(0);

      const inside = new MemoryLedger();
      await fundInner(inside);
      const insideSvc = serviceFor(
        holdLedger(inside, {
          onHoldPost: async () => {
            throw lostConnection();
          },
          onReadKey: async () => null,
        }),
        [],
      );
      await expect(insideSvc.placeOrder(principalFor(ALICE), limitBuy('cancel-inside'))).rejects.toThrow(/wait \d+ seconds/);
      const insideRow = await sql<Array<{ id: string }>>`SELECT id FROM trade.orders WHERE client_order_id = 'cancel-inside'`;
      await expect(insideSvc.cancelOrder(principalFor(ALICE), insideRow[0]!.id)).rejects.toThrow(/wait \d+ seconds/);
      expect(await sql`SELECT status FROM trade.orders WHERE id = ${insideRow[0]!.id}`).toEqual([{ status: 'hold_unknown' }]);
      expect(formatAmount((await inside.balance(orderHoldAccount(ALICE, 'USDT', insideRow[0]!.id))).amount)).toBe('0');
      expect(inside.journal().filter((tx) => tx.reason === 'order.hold')).toHaveLength(0);
      expect(inside.journal().filter((tx) => tx.reason === 'order.hold.released')).toHaveLength(0);
      expect(matching.cancelledOrders).toHaveLength(0);

      const past = new MemoryLedger();
      await fundInner(past);
      const pastSvc = serviceFor(
        holdLedger(past, {
          onHoldPost: async () => {
            throw lostConnection();
          },
          onReadKey: async () => null,
        }),
        [],
      );
      await expect(pastSvc.placeOrder(principalFor(ALICE), limitBuy('cancel-past'))).rejects.toMatchObject({ code: 'trade.hold_unknown' });
      const pastRow = await sql<Array<{ id: string }>>`SELECT id FROM trade.orders WHERE client_order_id = 'cancel-past'`;
      await sql`
        UPDATE trade.orders
           SET updated_at = now() - make_interval(secs => ${HOLD_UNKNOWN_IN_FLIGHT_BOUND_SECONDS + 1})
         WHERE id = ${pastRow[0]!.id}
      `;
      const cancelled = await pastSvc.cancelOrder(principalFor(ALICE), pastRow[0]!.id);
      expect(cancelled.status).toBe('cancelled');
      expect(formatAmount((await past.balance(orderHoldAccount(ALICE, 'USDT', pastRow[0]!.id))).amount)).toBe('0');
      expect(past.journal().filter((tx) => tx.reason === 'order.hold')).toHaveLength(0);
      expect(past.journal().filter((tx) => tx.reason === 'order.hold.released')).toHaveLength(0);
      expect(matching.submitted).toHaveLength(0);
      expect(matching.cancelledOrders).toHaveLength(0);

      const present = new MemoryLedger();
      await fundInner(present);
      let presentReads = 0;
      const presentSvc = serviceFor(
        holdLedger(present, {
          onHoldPost: async (book) => {
            await book();
            throw lostConnection();
          },
          onReadKey: async (key) => {
            presentReads += 1;
            if (presentReads === 1) throw lostConnection();
            return present.getTxByKey(key);
          },
        }),
        [],
      );
      await expect(presentSvc.placeOrder(principalFor(ALICE), limitBuy('cancel-present'))).rejects.toMatchObject({
        code: 'trade.hold_unknown',
      });
      const presentRow = await sql<Array<{ id: string }>>`SELECT id FROM trade.orders WHERE client_order_id = 'cancel-present'`;
      const released = await presentSvc.cancelOrder(principalFor(ALICE), presentRow[0]!.id);
      expect(released.status).toBe('cancelled');
      expect(formatAmount((await present.balance(orderHoldAccount(ALICE, 'USDT', presentRow[0]!.id))).amount)).toBe('0');
      expect(formatAmount((await present.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('5000');
      expect(present.journal().filter((tx) => tx.reason === 'order.hold')).toHaveLength(1);
      expect(present.journal().filter((tx) => tx.reason === 'order.hold.released')).toHaveLength(1);
      expect(matching.submitted).toHaveLength(0);
      expect(matching.cancelledOrders).toHaveLength(0);
    });

    it('sweep with spot disabled releases a booked hold and does not submit', async () => {
      const inner = new MemoryLedger();
      await fundInner(inner);
      let reads = 0;
      const alerts: HoldUnknownAlert[] = [];
      const client = holdLedger(inner, {
        onHoldPost: async (book) => {
          await book();
          throw lostConnection();
        },
        onReadKey: async (key) => {
          reads += 1;
          if (reads === 1) throw lostConnection();
          return inner.getTxByKey(key);
        },
      });
      const placer = serviceFor(client, alerts, { spotEnabled: true });
      await expect(placer.placeOrder(principalFor(ALICE), limitBuy('sweep-killed'))).rejects.toMatchObject({
        code: 'trade.hold_unknown',
      });
      const sweeper = serviceFor(client, alerts, { spotEnabled: false });
      const swept = await sweeper.sweepHoldUnknown();
      const row = await sql<Array<{ id: string; status: string }>>`
        SELECT id, status::text FROM trade.orders WHERE client_order_id = 'sweep-killed'
      `;
      expect(row).toEqual([{ id: row[0]!.id, status: 'rejected' }]);
      expect(swept.booked).toEqual([row[0]!.id]);
      expect(formatAmount((await inner.balance(orderHoldAccount(ALICE, 'USDT', row[0]!.id))).amount)).toBe('0');
      expect(inner.journal().filter((tx) => tx.reason === 'order.hold')).toHaveLength(1);
      expect(inner.journal().filter((tx) => tx.reason === 'order.hold.released')).toHaveLength(1);
      expect(matching.submitted).toHaveLength(0);
      expect(alerts.some((alert) => alert.resolution === 'booked' && alert.detail.includes('spot trading is disabled'))).toBe(true);
    });

    it('releases a taker order older than the cap instead of submitting it', async () => {
      const inner = new MemoryLedger();
      await fundInner(inner);
      let reads = 0;
      const alerts: HoldUnknownAlert[] = [];
      const svc = serviceFor(
        holdLedger(inner, {
          onHoldPost: async (book) => {
            await book();
            throw lostConnection();
          },
          onReadKey: async (key) => {
            reads += 1;
            if (reads === 1) throw lostConnection();
            return inner.getTxByKey(key);
          },
        }),
        alerts,
      );
      await expect(svc.placeOrder(principalFor(ALICE), limitBuy('stale-taker', 'IOC'))).rejects.toMatchObject({
        code: 'trade.hold_unknown',
      });
      await sql`
        UPDATE trade.orders SET created_at = now() - interval '60 seconds' WHERE client_order_id = 'stale-taker'
      `;
      const swept = await svc.sweepHoldUnknown();
      const row = await sql<Array<{ id: string; status: string }>>`
        SELECT id, status::text FROM trade.orders WHERE client_order_id = 'stale-taker'
      `;
      expect(row).toEqual([{ id: row[0]!.id, status: 'rejected' }]);
      expect(swept.booked).toEqual([row[0]!.id]);
      expect(formatAmount((await inner.balance(orderHoldAccount(ALICE, 'USDT', row[0]!.id))).amount)).toBe('0');
      expect(inner.journal().filter((tx) => tx.reason === 'order.hold')).toHaveLength(1);
      expect(inner.journal().filter((tx) => tx.reason === 'order.hold.released')).toHaveLength(1);
      expect(matching.submitted).toHaveLength(0);
      expect(alerts.some((alert) => alert.resolution === 'booked' && alert.detail.includes('taker order is older'))).toBe(true);
    });

    it('deletes the pending row when the hold was refused before any byte was sent', async () => {
      const inner = new MemoryLedger();
      await fundInner(inner);
      const svc = serviceFor(
        holdLedger(inner, {
          onHoldPost: async () => {
            throw neverSent();
          },
        }),
        [],
      );
      await expect(svc.placeOrder(principalFor(ALICE), limitBuy('never-sent'))).rejects.toThrow('fetch failed');
      expect(await sql`SELECT id FROM trade.orders`).toHaveLength(0);
      expect(formatAmount((await inner.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('5000');
      expect(inner.journal().filter((tx) => tx.reason === 'order.hold')).toHaveLength(0);
      expect(inner.journal().filter((tx) => tx.reason === 'order.hold.released')).toHaveLength(0);
      expect(matching.submitted).toHaveLength(0);
    });

    it('re-posts the same hold once when a retry reads absent inside the bound', async () => {
      const inner = new MemoryLedger();
      await fundInner(inner);
      let posts = 0;
      const svc = serviceFor(
        holdLedger(inner, {
          onHoldPost: async (book) => {
            posts += 1;
            if (posts === 1) throw lostConnection();
            return book();
          },
          onReadKey: async () => null,
        }),
        [],
      );
      await expect(svc.placeOrder(principalFor(ALICE), limitBuy('repost-once'))).rejects.toMatchObject({
        code: 'trade.hold_unknown',
      });
      matching.script1((req, next) => restsInFull(req, next()));
      const retried = await svc.placeOrder(principalFor(ALICE), limitBuy('repost-once'));
      expect(retried.status).toBe('open');
      expect(posts).toBe(2);
      expect(formatAmount((await inner.balance(orderHoldAccount(ALICE, 'USDT', retried.id))).amount)).toBe('10');
      expect(inner.journal().filter((tx) => tx.reason === 'order.hold')).toHaveLength(1);
      expect(inner.journal().filter((tx) => tx.reason === 'order.hold.released')).toHaveLength(0);
      expect(matching.submitted).toHaveLength(1);
      expect(await sql`SELECT status FROM trade.orders WHERE id = ${retried.id}`).toEqual([{ status: 'open' }]);
    });

    it('maps hold_unknown to recoveryRequired', () => {
      const wire = presentCcxtOrder(fakeOrder({ status: 'hold_unknown' }), 'BTC/USDT');
      expect(wire.recoveryRequired).toBe(true);
      expect(wire.holdUnknown).toBe(true);
    });

    it('sweep rejects a booked hold_unknown order when the venue schedule is closed', async () => {
      // Same closed-venue instant as the assertMarketOpen place door: Saturday FX.
      const saturday = new Date('2026-01-10T12:00:00Z');
      const inner = new MemoryLedger();
      await fundInner(inner, '20');
      await inner.post(
        recipes.deposit({
          userId: ALICE,
          assetId: 'USD',
          amount: amt('20'),
          rail: 'test',
          railRef: `closed-venue-usd:${Math.random()}`,
        }),
      );
      const alerts: HoldUnknownAlert[] = [];
      const svc = new TradeService(sql, inner, matching, perks, bus, {
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
        marketSlippageCapBps: 150,
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        now: () => saturday,
        onHoldUnknownAlert: (alert) => alerts.push(alert),
      });
      matching.script1((req, next) => restsInFull(req, next()));
      const proofOrder = await svc.placeOrder(principalFor(ALICE), limitBuy('closed-proof'));
      const proofRows = await sql<Array<{ proof: string }>>`
        SELECT lifecycle_proof::text AS proof FROM trade.orders WHERE id = ${proofOrder.id}
      `;
      const eurusd = await svc.listMarket({
        symbol: 'EUR/USD',
        baseAsset: 'EUR',
        quoteAsset: 'USD',
        tickSize: amt('0.00001'),
        lotSize: amt('1'),
        minQty: amt('1'),
        maxQty: null,
        minNotional: amt('1'),
        makerBps: 10,
        takerBps: 20,
        assetClass: 'forex',
        schedule: 'fx-global',
        paper: true,
      });
      const orderId = '44444444-4444-4444-8444-444444444444';
      await sql`
        INSERT INTO trade.orders (
          id, user_id, market_id, client_order_id, side, type, price, qty, status, tif,
          hold_asset, hold_amount, fee_discount_bps, seeded, lifecycle_proof, session_id
        ) VALUES (
          ${orderId}, ${ALICE}, ${eurusd.id}, 'sweep-closed', 'buy', 'limit',
          ${'1.10000'}::numeric, ${'1'}::numeric, 'hold_unknown', 'GTC',
          'USD', ${'10'}::numeric, 0, false, ${proofRows[0]!.proof}::jsonb,
          ${principalFor(ALICE).sid}
        )
      `;
      await inner.post(recipes.orderHold({ orderId, userId: ALICE, assetId: 'USD', amount: amt('10') }));
      const submittedBefore = matching.submitted.length;
      const swept = await svc.sweepHoldUnknown();
      const row = await sql<Array<{ status: string }>>`SELECT status::text FROM trade.orders WHERE id = ${orderId}`;
      expect(row).toEqual([{ status: 'rejected' }]);
      expect(swept.booked).toEqual([orderId]);
      const releases = inner.journal().filter((tx) => tx.reason === 'order.hold.released' && tx.idempotencyKey.includes(orderId));
      expect(releases).toHaveLength(1);
      expect(formatAmount((await inner.balance(orderHoldAccount(ALICE, 'USD', orderId))).amount)).toBe('0');
      expect(matching.submitted.slice(submittedBefore).filter((call) => call.request.orderId === orderId)).toHaveLength(0);
      expect(alerts.some((alert) => alert.orderId === orderId && alert.detail.includes('is closed'))).toBe(true);
    });

    it('past-bound delete and cancel leave a fresh hold_unknown row and write one that is 8 minutes old', async () => {
      const inner = new MemoryLedger();
      await fundInner(inner);
      const svc = serviceFor(
        holdLedger(inner, {
          onHoldPost: async () => {
            throw lostConnection();
          },
          onReadKey: async () => null,
        }),
        [],
      );
      await expect(svc.placeOrder(principalFor(ALICE), limitBuy('bound-fresh'))).rejects.toMatchObject({ code: 'trade.hold_unknown' });
      const fresh = await sql<Array<{ id: string }>>`SELECT id FROM trade.orders WHERE client_order_id = 'bound-fresh'`;
      const freshId = fresh[0]!.id;
      const writers = svc as unknown as {
        deleteAbsentHoldUnknownPastBound(orderId: string): Promise<number>;
        cancelAbsentHoldUnknownPastBound(orderId: string): Promise<number>;
      };

      expect(await writers.deleteAbsentHoldUnknownPastBound(freshId)).toBe(0);
      expect(await writers.cancelAbsentHoldUnknownPastBound(freshId)).toBe(0);
      expect(await sql`SELECT status::text FROM trade.orders WHERE id = ${freshId}`).toEqual([{ status: 'hold_unknown' }]);

      await sql`UPDATE trade.orders SET updated_at = now() - interval '8 minutes' WHERE id = ${freshId}`;
      expect(await writers.deleteAbsentHoldUnknownPastBound(freshId)).toBe(1);
      expect(await sql`SELECT id FROM trade.orders WHERE id = ${freshId}`).toHaveLength(0);

      await expect(svc.placeOrder(principalFor(ALICE), limitBuy('bound-cancel'))).rejects.toMatchObject({ code: 'trade.hold_unknown' });
      const past = await sql<Array<{ id: string }>>`SELECT id FROM trade.orders WHERE client_order_id = 'bound-cancel'`;
      const pastId = past[0]!.id;
      await sql`UPDATE trade.orders SET updated_at = now() - interval '8 minutes' WHERE id = ${pastId}`;
      expect(await writers.cancelAbsentHoldUnknownPastBound(pastId)).toBe(1);
      expect(await sql`SELECT status::text FROM trade.orders WHERE id = ${pastId}`).toEqual([{ status: 'cancelled' }]);
      expect(inner.journal().filter((tx) => tx.reason === 'order.hold')).toHaveLength(0);
      expect(inner.journal().filter((tx) => tx.reason === 'order.hold.released')).toHaveLength(0);
    });

    it('cancel-all cancels the older open order when a newer hold_unknown row refuses', async () => {
      const inner = new MemoryLedger();
      await fundInner(inner);
      let posts = 0;
      const svc = serviceFor(
        holdLedger(inner, {
          onHoldPost: async (book) => {
            posts += 1;
            if (posts === 1) return book();
            throw lostConnection();
          },
          onReadKey: async () => null,
        }),
        [],
      );
      matching.script1((req, next) => restsInFull(req, next()));
      const older = await svc.placeOrder(principalFor(ALICE), limitBuy('cancel-all-older'));
      await sql`UPDATE trade.orders SET created_at = now() - interval '1 minute' WHERE id = ${older.id}`;
      await expect(svc.placeOrder(principalFor(ALICE), limitBuy('cancel-all-unknown'))).rejects.toMatchObject({
        code: 'trade.hold_unknown',
      });

      await expect(svc.cancelAllOrders(principalFor(ALICE))).rejects.toMatchObject({ code: 'trade.hold_unknown' });

      expect(await sql`SELECT status::text FROM trade.orders WHERE id = ${older.id}`).toEqual([{ status: 'cancelled' }]);
      expect(formatAmount((await inner.balance(orderHoldAccount(ALICE, 'USDT', older.id))).amount)).toBe('0');
      expect(inner.journal().filter((tx) => tx.reason === 'order.hold.released' && tx.idempotencyKey.includes(older.id))).toHaveLength(1);
      const unknown = await sql<Array<{ id: string; status: string }>>`
        SELECT id, status::text FROM trade.orders WHERE client_order_id = 'cancel-all-unknown'
      `;
      expect(unknown).toEqual([{ id: unknown[0]!.id, status: 'hold_unknown' }]);
      expect(
        inner.journal().filter((tx) => tx.reason === 'order.hold' && tx.idempotencyKey === `order.hold:${unknown[0]!.id}`),
      ).toHaveLength(0);
      expect(
        inner.journal().filter((tx) => tx.reason === 'order.hold.released' && tx.idempotencyKey.includes(unknown[0]!.id)),
      ).toHaveLength(0);
    });
  });
});
