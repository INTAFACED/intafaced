import { PositionService } from '../controls/test-admission.js';
/**
 * Position open/close against real trade schema + MemoryLedger.
 * H8a PG-hard: never skip-green when Postgres is down.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryLedger,
  formatAmount,
  houseFees,
  insuranceFund,
  parseAmount as amt,
  positionCollateralAccount,
  recipes,
  userAvailable,
} from '@intafaced/ledger-client';
import { MemoryEventBus } from '@intafaced/events';
import { FuturesError } from './position-service.js';
import { memoryMarkBook } from './mark-source.js';
import { markSourceFromDepth } from './mark-from-depth.js';
import { runLiquidationTick, memoryLiquidationAttemptStore } from './liquidation-tick.js';
import { runFundingTick } from './funding-tick.js';
import { sqlFundingPositionLoader, sqlLiquidationPositionLoader } from './position-loaders.js';
import { sqlFundingMarginApplier, sqlFundingPeriodStore, sqlPositionCloser, sqlPositionReducer } from './tick-stores.js';
import { sqlAcceptedMarkStore } from './accepted-mark.js';
import type { EngineDepth } from '../spot/matching-client.js';
import { formatAccountRef, profitSourceFromConfig, recipeProfitFundingAccount } from './profit-source.js';
import { TEST_MAX_LEVERAGE_AMOUNT } from './initial-margin.test-harness.js';

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
      `H8a: svc-trade position-service is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

const ALICE = '11111111-1111-4111-8111-111111111111';
/** Someone else entirely — used only to route seed value into the house pot. */
const BOB = '22222222-2222-4222-8222-222222222222';

describe('H8a money suite is not skip-green', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-trade position-service (H8a PG-hard)', () => {
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
  let positions: PositionService;
  let marks: ReturnType<typeof memoryMarkBook>;

  /**
   * THE MARK FEED THE CALLER CANNOT REACH.
   *
   * Every price in this suite is set here, on the feed, and never passed to
   * `open()` or `close()` — because after
   * `docs/adr/2026-08-05-futures-risk-and-mark-law.md` neither method takes one.
   * A test that wants a different exit price moves the FEED, which is exactly
   * the distinction the ADR draws.
   */
  const NOW = new Date('2026-08-06T12:00:00.000Z');
  const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  function feed(price: string, quality: 'index' | 'mid' | 'last' = 'mid', at: Date = NOW) {
    marks.set({ marketId: MARKET, price, quality, asOfMs: at.getTime() });
  }

  /** The pot realised profit is paid from — named, never defaulted. */
  const PROFIT_SOURCE = formatAccountRef(recipeProfitFundingAccount('USDT'));

  function build() {
    return new PositionService(sql, ledger, {
      marks: marks.source(),
      profitSource: profitSourceFromConfig(PROFIT_SOURCE),
      maxLeverage: TEST_MAX_LEVERAGE_AMOUNT,
      bus,
      now: () => NOW,
    });
  }

  /**
   * Fund the profit pot the way it actually fills: somebody else's realised
   * loss, drawn from margin they had really locked. Three real recipes, no
   * fixture poking a balance into place — so the ceiling these tests assert
   * against is a balance the ledger agrees exists.
   */
  async function fundProfitSource(amount: string) {
    const seedPosition = `pot-seed-${randomUUID()}`;
    await ledger.post(recipes.deposit({ userId: BOB, assetId: 'USDT', amount: amt(amount), rail: 'test', railRef: `pot-${randomUUID()}` }));
    await ledger.post(recipes.futuresMarginLock({ positionId: seedPosition, userId: BOB, assetId: 'USDT', amount: amt(amount) }));
    await ledger.post(
      recipes.futuresRealizeLoss({
        positionId: seedPosition,
        userId: BOB,
        assetId: 'USDT',
        fromMargin: amt(amount),
        fromInsurance: 0n,
        lossId: seedPosition,
      }),
    );
  }

  const profitPot = () => houseFees('trade', 'USDT');

  beforeEach(async () => {
    await sql`TRUNCATE trade.positions, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    bus = new MemoryEventBus('svc-trade');
    marks = memoryMarkBook();
    positions = build();
    await sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'BTC/USDT-PERP',
        'BTC',
        'USDT',
        'futures',
        '0.01',
        '0.0001',
        '0.0001',
        '1',
        10,
        20,
        'active',
        'BTC perpetual',
        now()
      )
    `;
    await ledger.post(
      recipes.deposit({
        userId: ALICE,
        assetId: 'USDT',
        amount: amt('100000'),
        rail: 'test',
        railRef: `fund-${Math.random()}`,
      }),
    );
  });

  /**
   * 30s, not vitest's default 10s. Dropping a DATABASE is heavier than closing a
   * pool, and when several suite files tear down at the same moment Postgres
   * serialises the drops. The work still finishes well inside this; the default
   * was sized for `sql.end()`, which is all this hook used to do.
   */

  it('open prices from the feed, locks margin, and listOpen returns the row', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-open-position-service.test-1',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    expect(pos.side).toBe('long');
    expect(pos.contracts).toBe('1');
    // The entry price came from the FEED, and it sized the margin.
    expect(pos.entryPrice).toBe('50000');
    expect(pos.initialMargin).toBe('5000');
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('95000');
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('5000');

    const listed = await positions.listOpen(ALICE);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(pos.id);

    const got = await positions.get(ALICE, pos.id!);
    expect(got.id).toBe(pos.id);
    expect(got.entryPrice).toBe('50000');
    expect(got.markPrice).toBeNull();
  });

  it('open refuses a dated market whose expiry has passed — not a perp', async () => {
    await sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at,
        futures_contract_style, futures_expiry_at, futures_settlement_fixing
      ) VALUES (
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        'BTC/USDT:USDT-251226',
        'BTC',
        'USDT',
        'futures',
        '0.01',
        '0.0001',
        '0.0001',
        '1',
        10,
        20,
        'active',
        'BTC dated',
        now(),
        'dated',
        '2020-01-01T00:00:00.000Z',
        'owner-dated-fixing'
      )
    `;
    feed('50000');
    await expect(
      positions.open({
        clientOpenId: 't-open-dated-expired',
        userId: ALICE,
        symbol: 'BTC/USDT:USDT-251226',
        side: 'long',
        size: amt('1'),
        leverage: amt('10'),
      }),
    ).rejects.toMatchObject({ code: 'trade.dated_futures_expired' });
    expect(FuturesError).toBeDefined();
  });

  it('close releases margin and empties listOpen', async () => {
    feed('40000');
    const pos = await positions.open({
      clientOpenId: 't-open-position-service.test-2',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'short',
      size: amt('0.5'),
      leverage: amt('5'),
    });
    // margin = 0.5 * 40000 / 5 = 4000 — flat close, the feed has not moved.
    await positions.close(ALICE, pos.id!);
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('100000');
    expect(await positions.listOpen(ALICE)).toEqual([]);
  });

  it('get returns a closed row instead of inventing it gone', async () => {
    feed('40000');
    const pos = await positions.open({
      clientOpenId: 't-get-closed-position',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'short',
      size: amt('0.5'),
      leverage: amt('5'),
    });
    await positions.close(ALICE, pos.id!);
    expect(await positions.listOpen(ALICE)).toEqual([]);
    const got = await positions.get(ALICE, pos.id!);
    expect(got.id).toBe(pos.id);
    expect(got.status).toBe('closed');
  });

  it('listClosed returns settled rows and stays empty for another user', async () => {
    feed('40000');
    const pos = await positions.open({
      clientOpenId: 't-list-closed-position',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'short',
      size: amt('0.5'),
      leverage: amt('5'),
    });
    expect(await positions.listClosed(ALICE, { limit: 100 })).toEqual([]);
    await positions.close(ALICE, pos.id!);
    expect(await positions.listOpen(ALICE)).toEqual([]);
    const closed = await positions.listClosed(ALICE, { limit: 100 });
    expect(closed).toHaveLength(1);
    expect(closed[0]!.id).toBe(pos.id);
    expect(closed[0]!.status).toBe('closed');
    expect(closed[0]!.markPrice).toBeNull();
    expect(await positions.listClosed(BOB, { limit: 100 })).toEqual([]);
  });

  it('listClosed pages with limit and since in SQL', async () => {
    feed('50000');
    const first = await positions.open({
      clientOpenId: 't-list-closed-page-1',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    await positions.close(ALICE, first.id!);
    const second = await positions.open({
      clientOpenId: 't-list-closed-page-2',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    await positions.close(ALICE, second.id!);
    expect(await positions.listClosed(ALICE, { limit: 100 })).toHaveLength(2);
    expect(await positions.listClosed(ALICE, { limit: 1 })).toHaveLength(1);
    expect(await positions.listClosed(ALICE, { limit: 100, sinceMs: Date.now() + 86_400_000 })).toEqual([]);
    expect(await positions.listClosed(ALICE, { limit: 100, sinceMs: 0 })).toHaveLength(2);
  });

  it('get missing or not-theirs is the same 404', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-get-not-theirs',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    await expect(positions.get(ALICE, randomUUID())).rejects.toMatchObject({
      code: 'trade.position_not_found',
      status: 404,
    });
    await expect(positions.get(BOB, pos.id!)).rejects.toMatchObject({
      code: 'trade.position_not_found',
      status: 404,
    });
  });

  it('publishes positionUpdated on open and close (F4 private WS feed)', async () => {
    feed('50000');
    const seen: Array<{ status: string; side: string }> = [];
    await bus.subscribe(
      'positionUpdated',
      async (payload) => {
        seen.push({ status: payload.status, side: payload.side });
      },
      { durable: 'test-position-updated' },
    );
    const pos = await positions.open({
      clientOpenId: 't-open-position-service.test-3',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    await positions.close(ALICE, pos.id!);
    expect(seen).toEqual([
      { status: 'open', side: 'long' },
      { status: 'closed', side: 'long' },
    ]);
    // Also retained on the bus for idempotency inspection
    expect(bus.emitted('positionUpdated')).toHaveLength(2);
  });

  // ── D-S-01: a price that moves money is never supplied by the party it pays ──

  /**
   * The defect this branch closes, stated as a test.
   *
   * There is no longer any argument through which a caller can name their own
   * exit price, so the proof is that the PnL follows the feed and only the feed.
   * A trader who could name '60000' here would have taken 10000 USDT out of the
   * house pot; the feed says 50000, so they take nothing.
   */
  it('realised PnL follows the feed, and the caller has no argument to change it', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-open-position-service.test-4',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });

    // `close` takes a user id and a position id. That is the whole signature.
    expect(positions.close.length).toBe(2);

    await positions.close(ALICE, pos.id!);
    // Flat: exactly the margin back, no profit conjured out of a named price.
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('100000');
    expect(formatAmount((await ledger.balance(profitPot())).amount)).toBe('0');
  });

  it('a real move in the feed does pay out — the price is read, not ignored', async () => {
    feed('50000');
    await fundProfitSource('10000');
    const pos = await positions.open({
      clientOpenId: 't-open-position-service.test-5',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    feed('51000');
    await positions.close(ALICE, pos.id!);
    // 100000 - 5000 margin + 5000 margin back + 1000 profit
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('101000');
    expect(formatAmount((await ledger.balance(profitPot())).amount)).toBe('9000');
  });

  // ── D-S-07: a missing mark is not a zero mark ────────────────────────────────

  it('refuses open without clientOpenId — no random id, no margin lock', async () => {
    await expect(
      positions.open({
        userId: ALICE,
        symbol: 'BTC/USDT-PERP',
        side: 'long',
        size: amt('1'),
        leverage: amt('10'),
        clientOpenId: '',
      }),
    ).rejects.toMatchObject({ code: 'trade.client_open_id_required' });
    expect(ledger.journal().filter((tx) => String(tx.reason).includes('futures.margin'))).toHaveLength(0);
  });

  /**
   * DIRECTION MVP-1 / D26-P1-T1a: entry mark is not last-trade. A `last` quote
   * is still fine to show and can let a loser out — it must not size a new lock.
   */
  it('refuses to OPEN on a `last` mark, and no margin is locked', async () => {
    feed('50000', 'last');
    await fundProfitSource('10000');
    const before = formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount);
    await expect(
      positions.open({
        clientOpenId: 't-open-last-trade-refused',
        userId: ALICE,
        symbol: 'BTC/USDT-PERP',
        side: 'long',
        size: amt('1'),
        leverage: amt('10'),
      }),
    ).rejects.toMatchObject({ code: 'trade.mark_unusable' });
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe(before);
    expect(await positions.listOpen(ALICE)).toEqual([]);
  });

  it('refuses to OPEN when the feed has no mark, and no margin is locked', async () => {
    const before = (await ledger.balance(userAvailable(ALICE, 'USDT'))).amount;
    await expect(
      positions.open({
        clientOpenId: 't-open-position-service.test-6',
        userId: ALICE,
        symbol: 'BTC/USDT-PERP',
        side: 'long',
        size: amt('1'),
        leverage: amt('10'),
      }),
    ).rejects.toMatchObject({ code: 'trade.mark_missing' });

    // Nothing moved, and no row was written.
    expect((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount).toBe(before);
    expect(await positions.listOpen(ALICE)).toEqual([]);
  });

  /**
   * DONE BAR (exit-when-dark): a missing mark does not trap the trader.
   * Close freezes to `closing` — no money moves, collateral stays locked,
   * and the row is honest about limbo (never renders as `open`).
   */
  it('freezes to closing when the feed goes dark on voluntary close — no 503, no payout', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-open-position-service.test-7',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    const afterOpen = (await ledger.balance(userAvailable(ALICE, 'USDT'))).amount;
    marks.clear(MARKET);

    const frozen = await positions.close(ALICE, pos.id!);
    expect(frozen.status).toBe('closing');
    expect(frozen.closingReason).toBe('trade.mark_missing');
    expect(frozen.id).toBe(pos.id);

    expect((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount).toBe(afterOpen);
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('5000');
    const still = await positions.listOpen(ALICE);
    expect(still).toHaveLength(1);
    expect(still[0]!.status).toBe('closing');
    expect(still[0]!.closingReason).toBe('trade.mark_missing');
  });

  /** The specific broken case the ADR names: a LOSING close must not fail when dark. */
  it('a losing close with no usable mark freezes rather than fails', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-open-position-service.test-8',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    // Would be a loss at 49000 — but the feed is gone entirely.
    marks.clear(MARKET);
    const frozen = await positions.close(ALICE, pos.id!);
    expect(frozen.status).toBe('closing');
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('5000');
  });

  it('retrying close while dark is idempotent — same closing row, not an error', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-open-position-service.test-9',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    marks.clear(MARKET);
    const first = await positions.close(ALICE, pos.id!);
    const second = await positions.close(ALICE, pos.id!);
    expect(second.id).toBe(first.id);
    expect(second.status).toBe('closing');
    expect(second.closingReason).toBe(first.closingReason);
    expect(await positions.listOpen(ALICE)).toHaveLength(1);
  });

  it('freezes when the mark is stale past the marking limit (unusable, not invent)', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-open-position-service.test-10',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    feed('51000', 'mid', new Date(NOW.getTime() - 400_000));
    const frozen = await positions.close(ALICE, pos.id!);
    expect(frozen.status).toBe('closing');
    expect(frozen.closingReason).toBe('trade.mark_unusable');
    expect(await positions.listOpen(ALICE)).toHaveLength(1);
  });

  /**
   * Settlement at mark return — feed return is the trigger; exit price is the
   * freeze-time accepted_mark (Denon handoff §§3–4). Asserted on BALANCES.
   * A better mark while we were dark must NOT mint post-exit profit.
   */
  it('settles a closing position when the mark returns — balances move once', async () => {
    feed('50000');
    await fundProfitSource('10000');
    const pos = await positions.open({
      clientOpenId: 't-open-position-service.test-11',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    marks.clear(MARKET);
    await positions.close(ALICE, pos.id!);
    expect((await positions.listOpen(ALICE))[0]!.status).toBe('closing');

    // Better mark during outage — must not pay 1000 of post-exit profit.
    feed('51000');
    await positions.close(ALICE, pos.id!);
    // Margin back only: 100000 − 5000 + 5000, freeze basis = entry → flat.
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('100000');
    expect(formatAmount((await ledger.balance(profitPot())).amount)).toBe('10000');
    expect(await positions.listOpen(ALICE)).toEqual([]);
  });

  /**
   * Denon handoff §3 reproduction: worse mark while closing must not charge
   * the dark-period move. Exit = freeze accepted_mark, not live mark.
   */
  it('a closing position is not charged a worse mark that arrived during the outage', async () => {
    feed('100');
    await fundProfitSource('10000');
    const pos = await positions.open({
      clientOpenId: 't-open-position-service.test-closing-worse',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('10'),
      leverage: amt('10'),
    });
    // margin = 100 (notional 1000 / lev 10). available after open = 99900.
    marks.clear(MARKET);
    await positions.close(ALICE, pos.id!);
    expect((await positions.listOpen(ALICE))[0]!.status).toBe('closing');

    // 15% crash entirely while dark — live settle would charge 150; freeze settle = flat.
    feed('85');
    await positions.close(ALICE, pos.id!);
    expect(await positions.listOpen(ALICE)).toEqual([]);
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('100000');
  });

  /**
   * Denon handoff §4: breaker trap dissolves — settling at freeze basis means
   * there is no deviation to breach, so a huge return mark cannot trap the exit.
   */
  it('settlement from closing uses freeze accepted_mark so a breaker-sized return mark cannot trap', async () => {
    feed('100');
    await fundProfitSource('10000000');
    const pos = await positions.open({
      clientOpenId: 't-open-position-service.test-12',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('500'),
      leverage: amt('1'),
    });
    marks.clear(MARKET);
    await positions.close(ALICE, pos.id!);
    expect((await positions.listOpen(ALICE))[0]!.status).toBe('closing');

    // 100x jump — would refuse if we re-priced against accepted_mark. Freeze settle exits flat.
    feed('10000');
    await positions.close(ALICE, pos.id!);
    expect(await positions.listOpen(ALICE)).toEqual([]);
    // No profit minted from the jump; pot untouched.
    expect(formatAmount((await ledger.balance(profitPot())).amount)).toBe('10000000');
  });
  /**
   * The asymmetry, in the close path. A `last` mark is fine to show and not
   * fine to pay on — but it must not trap a trader in a losing position either.
   */
  it('refuses to pay PROFIT on a `last` mark, but still lets a losing position out on one', async () => {
    feed('50000');
    await fundProfitSource('10000');
    const winner = await positions.open({
      clientOpenId: 't-open-position-service.test-13',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });

    feed('51000', 'last');
    await expect(positions.close(ALICE, winner.id!)).rejects.toMatchObject({ code: 'trade.mark_unusable' });
    expect(formatAmount((await ledger.balance(profitPot())).amount)).toBe('10000');
    expect(await positions.listOpen(ALICE)).toHaveLength(1);

    // The same mark quality, the other direction: the trader gets out.
    feed('49000', 'last');
    await positions.close(ALICE, winner.id!);
    expect(await positions.listOpen(ALICE)).toEqual([]);
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('99000');
  });

  // ── The payout bound ─────────────────────────────────────────────────────────

  /**
   * A house account is not an insurance fund and a fee balance is not a risk
   * budget. The balance is the ceiling, and exceeding it refuses.
   */
  it('refuses a payout larger than the profit source, and nothing moves', async () => {
    feed('50000');
    await fundProfitSource('500');
    const pos = await positions.open({
      clientOpenId: 't-open-position-service.test-14',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    const userBefore = (await ledger.balance(userAvailable(ALICE, 'USDT'))).amount;

    // +1000 of profit against a pot holding 500.
    feed('51000');
    await expect(positions.close(ALICE, pos.id!)).rejects.toMatchObject({ code: 'trade.profit_source_underfunded' });

    // THE BALANCES, not the exception. The pot is untouched, the trader's
    // available is untouched, the margin is still locked, the row is still open.
    expect(formatAmount((await ledger.balance(profitPot())).amount)).toBe('500');
    expect((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount).toBe(userBefore);
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('5000');
    expect(await positions.listOpen(ALICE)).toHaveLength(1);
  });

  it('pays a profit exactly equal to the source balance — the bound is a ceiling, not a margin of safety', async () => {
    feed('50000');
    await fundProfitSource('1000');
    const pos = await positions.open({
      clientOpenId: 't-open-position-service.test-15',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    feed('51000');
    await positions.close(ALICE, pos.id!);
    expect(formatAmount((await ledger.balance(profitPot())).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('101000');
  });

  it('the bound never blocks a losing close — a control that traps funds is not a control', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-open-position-service.test-16',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    // Profit pot is empty. A loss does not draw on it.
    expect(formatAmount((await ledger.balance(profitPot())).amount)).toBe('0');
    feed('49000');
    await positions.close(ALICE, pos.id!);
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('99000');
    expect(await positions.listOpen(ALICE)).toEqual([]);
  });

  /**
   * Insurance shortfall bound on voluntary close — mirror of the liquidation
   * tick. Loss past margin needs the fund; empty fund refuses; position stays
   * open; no ledger overdraw.
   */
  it('refuses a bankrupt voluntary close when the insurance fund is empty', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-open-position-service.test-17',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    // margin 5000; exit 44000 → loss 6000 → fromInsurance 1000. Fund is empty.
    expect(formatAmount((await ledger.balance(insuranceFund('USDT'))).amount)).toBe('0');
    const marginBefore = (await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount;
    const userBefore = (await ledger.balance(userAvailable(ALICE, 'USDT'))).amount;

    feed('44000');
    await expect(positions.close(ALICE, pos.id!)).rejects.toMatchObject({ code: 'trade.insurance_underfunded' });

    expect((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount).toBe(marginBefore);
    expect((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount).toBe(userBefore);
    expect(formatAmount((await ledger.balance(insuranceFund('USDT'))).amount)).toBe('0');
    expect(await positions.listOpen(ALICE)).toHaveLength(1);
  });

  /**
   * The second door. TypeScript already makes `'cross'` unrepresentable in
   * `OpenPositionInput`, so this test has to force it — which is the point: a
   * caller that is not TypeScript still cannot open a cross-margin position,
   * and no margin is locked on the way to finding that out.
   */
  it('refuses cross margin at the service, and locks nothing', async () => {
    feed('50000');
    const before = (await ledger.balance(userAvailable(ALICE, 'USDT'))).amount;
    await expect(
      positions.open({
        clientOpenId: 't-open-position-service.test-18',
        userId: ALICE,
        symbol: 'BTC/USDT-PERP',
        side: 'long',
        size: amt('1'),
        leverage: amt('10'),
        marginMode: 'cross' as unknown as 'isolated',
      }),
    ).rejects.toMatchObject({ code: 'trade.cross_margin_unsupported' });

    expect((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount).toBe(before);
    expect(await positions.listOpen(ALICE)).toEqual([]);
  });

  it('refuses portfolio at the service (owner scenario unset), and locks nothing', async () => {
    feed('50000');
    const before = (await ledger.balance(userAvailable(ALICE, 'USDT'))).amount;
    await expect(
      positions.open({
        clientOpenId: 't-open-position-service.test-18b',
        userId: ALICE,
        symbol: 'BTC/USDT-PERP',
        side: 'long',
        size: amt('1'),
        leverage: amt('10'),
        marginMode: 'portfolio' as unknown as 'isolated',
      }),
    ).rejects.toMatchObject({ code: 'trade.portfolio_margin_unset' });
    expect((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount).toBe(before);
    expect(await positions.listOpen(ALICE)).toEqual([]);
  });

  it('refuses yield-bearing collateral as IM, and locks nothing', async () => {
    feed('50000');
    const before = (await ledger.balance(userAvailable(ALICE, 'USDT'))).amount;
    await expect(
      positions.open({
        clientOpenId: 't-open-position-service.test-18c',
        userId: ALICE,
        symbol: 'BTC/USDT-PERP',
        side: 'long',
        size: amt('1'),
        leverage: amt('10'),
        marginMode: 'isolated',
        collateralClass: 'yield_bearing',
      }),
    ).rejects.toMatchObject({ code: 'trade.unsupported_collateral_class' });
    expect((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount).toBe(before);
    expect(await positions.listOpen(ALICE)).toEqual([]);
  });

  it('opens isolated when the mode is omitted, and says so on the wire', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-open-position-service.test-19',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    expect(pos.marginMode).toBe('isolated');
  });

  it('refuses spot market as futures open', async () => {
    await sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        'ETH/USDT',
        'ETH',
        'USDT',
        'spot',
        '0.01',
        '0.0001',
        '0.0001',
        '1',
        10,
        20,
        'active',
        'ETH spot',
        now()
      )
    `;
    await expect(
      positions.open({
        clientOpenId: 't-open-position-service.test-20',
        userId: ALICE,
        symbol: 'ETH/USDT',
        side: 'long',
        size: amt('1'),
        leverage: amt('2'),
      }),
    ).rejects.toMatchObject({ code: 'trade.not_futures_market' });
  });

  // ── Futures with no profit source named: the FEATURE is off, not the service ──

  /**
   * `index.ts` used to call `profitSourceFromConfig` at module scope, which
   * throws on an empty value — and `.env.example` ships the variable commented
   * out while compose passes `${TRADE_FUTURES_PROFIT_SOURCE:-}`. So a clean
   * clone crash-looped svc-trade: spot orders, ticker, orderbook, balances,
   * fees, positions and the websocket feeds, all down over a futures payout pot.
   *
   * The blast radius now matches the scope of the decision. These three tests
   * are what "futures is disabled" means, stated in balances.
   */
  function withoutProfitSource() {
    return new PositionService(sql, ledger, {
      marks: marks.source(),
      profitSource: null,
      bus,
      now: () => NOW,
    });
  }

  it('refuses to OPEN when no profit source is named, and locks nothing', async () => {
    feed('50000');
    const before = (await ledger.balance(userAvailable(ALICE, 'USDT'))).amount;
    await expect(
      withoutProfitSource().open({
        clientOpenId: 't-open-position-service.test-21',
        userId: ALICE,
        symbol: 'BTC/USDT-PERP',
        side: 'long',
        size: amt('1'),
        leverage: amt('10'),
      }),
    ).rejects.toMatchObject({ code: 'trade.futures_unconfigured', status: 403 });

    expect((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount).toBe(before);
    expect(await positions.listOpen(ALICE)).toEqual([]);
  });

  function withoutMaxLeverage() {
    return new PositionService(sql, ledger, {
      marks: marks.source(),
      profitSource: profitSourceFromConfig(PROFIT_SOURCE),
      bus,
      now: () => NOW,
    });
  }

  it('refuses to OPEN when the listing leverage cap is unset, and locks nothing', async () => {
    feed('50000');
    const before = (await ledger.balance(userAvailable(ALICE, 'USDT'))).amount;
    await expect(
      withoutMaxLeverage().open({
        clientOpenId: 't-open-position-service.test-cap-default',
        userId: ALICE,
        symbol: 'BTC/USDT-PERP',
        side: 'long',
        size: amt('1'),
        leverage: amt('11'),
      }),
    ).rejects.toMatchObject({ code: 'trade.leverage_cap_unset', status: 503 });

    expect((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount).toBe(before);
    expect(await positions.listOpen(ALICE)).toEqual([]);
  });

  /**
   * A position opened while a pot WAS configured. Profit cannot be paid from an
   * account nobody chose — the ADR's rule, unchanged — so the close refuses and
   * the books are exactly as they were.
   */
  it('refuses a PROFITABLE close when no profit source is named, and nothing moves', async () => {
    feed('50000');
    await fundProfitSource('10000');
    const pos = await positions.open({
      clientOpenId: 't-open-position-service.test-22',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    const userBefore = (await ledger.balance(userAvailable(ALICE, 'USDT'))).amount;

    feed('51000');
    await expect(withoutProfitSource().close(ALICE, pos.id!)).rejects.toMatchObject({
      code: 'trade.profit_source_unconfigured',
      status: 403,
    });

    expect((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount).toBe(userBefore);
    expect(formatAmount((await ledger.balance(profitPot())).amount)).toBe('10000');
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('5000');
    expect(await positions.listOpen(ALICE)).toHaveLength(1);
  });

  /**
   * And the trader is not trapped. A losing close pays nothing out of any pot,
   * so an unnamed pot has no bearing on it — the same reasoning that lets a
   * losing position out on a `last` mark. A control that traps funds is not a
   * safety control.
   */
  it('still lets a LOSING position out when no profit source is named', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-open-position-service.test-23',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    feed('49000');
    await withoutProfitSource().close(ALICE, pos.id!);
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('99000');
    expect(await positions.listOpen(ALICE)).toEqual([]);
  });

  // ── D-S-07: the deviation breaker, armed ────────────────────────────────────

  /**
   * THE DEFECT, STATED IN BALANCES.
   *
   * `acceptableForLiquidation` skips the deviation breaker when `previous` is
   * `null`, and `requirePayoutGrade` passed a literal `null`. Measured on this
   * exact scenario before the fix: Alice's available went 100,000 → 5,050,000
   * and the profit pot went 5,000,000 → 50,000. **4,950,000 USDT paid out on a
   * feed that moved 100x in one step** — which confirms the figure the earlier
   * review reported.
   *
   * REVERT PROOF: put `null` back in `requirePayoutGrade`, or drop
   * `accepted_mark` from the INSERT in `open()`, and this test goes red on the
   * balance lines below — not on an outcome string.
   */
  it('refuses to pay out through a 100x mark jump, and the 4,950,000 stays in the pot', async () => {
    feed('100');
    await fundProfitSource('5000000');
    const pos = await positions.open({
      clientOpenId: 't-open-position-service.test-24',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('500'),
      leverage: amt('1'),
    });
    expect(pos.entryPrice).toBe('100');
    const userAfterOpen = (await ledger.balance(userAvailable(ALICE, 'USDT'))).amount;

    // 100x, in one step, on a feed nobody audited.
    feed('10000');
    await expect(positions.close(ALICE, pos.id!)).rejects.toMatchObject({ code: 'trade.mark_unusable' });

    // THE BALANCES. 4,950,000 did not move.
    expect(formatAmount((await ledger.balance(profitPot())).amount)).toBe('5000000');
    expect((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount).toBe(userAfterOpen);
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('50000');
    expect(await positions.listOpen(ALICE)).toHaveLength(1);
  });

  /**
   * The basis is the ENTRY mark, from the moment the position exists. Nothing
   * else has valued this position yet, so if `open()` did not record it the
   * first close would be a "first valuation" and unarmed — which is the defect
   * with one extra step in front of it.
   */
  it('arms the breaker at OPEN — the very first close is measured against the entry mark', async () => {
    feed('100');
    await fundProfitSource('100000');
    const pos = await positions.open({
      clientOpenId: 't-open-position-service.test-25',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('10'),
      leverage: amt('1'),
    });
    const [row] = await sql<{ accepted_mark: string }[]>`SELECT accepted_mark FROM trade.positions WHERE id = ${pos.id!}`;
    expect(formatAmount(amt(row!.accepted_mark))).toBe('100');

    // 30% up in one step: past the 2000bps breaker on the position's FIRST close.
    feed('130');
    await expect(positions.close(ALICE, pos.id!)).rejects.toMatchObject({ code: 'trade.mark_unusable' });
    expect(formatAmount((await ledger.balance(profitPot())).amount)).toBe('100000');
  });

  /**
   * A move inside the breaker is still paid. A circuit breaker that refuses
   * every payout is not a control, it is an outage.
   */
  it('pays a move INSIDE the breaker — the basis refuses jumps, not profits', async () => {
    feed('100');
    await fundProfitSource('100000');
    const pos = await positions.open({
      clientOpenId: 't-open-position-service.test-26',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('10'),
      leverage: amt('1'),
    });
    // +19%, under the 2000bps default.
    feed('119');
    await positions.close(ALICE, pos.id!);
    // 100000 - 1000 margin + 1000 margin back + 190 profit
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('100190');
    expect(formatAmount((await ledger.balance(profitPot())).amount)).toBe('99810');
  });

  /**
   * NO RATCHET. The basis is written inside the close transaction, so a REFUSED
   * close rolls it back. If it were written on the read instead, a caller could
   * walk the basis up in sub-breaker steps — attempt, refuse, attempt, refuse —
   * and arrive at any price they liked, one refusal at a time.
   *
   * REVERT PROOF: move the `accepted_mark` write out of the transaction, or
   * record it in `markFor()`, and the balance assertions below go red.
   */
  it('a refused close does not move the basis — the breaker cannot be ratcheted', async () => {
    feed('100');
    await fundProfitSource('1000000');
    const pos = await positions.open({
      clientOpenId: 't-open-position-service.test-27',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('100'),
      leverage: amt('1'),
    });
    const userAfterOpen = (await ledger.balance(userAvailable(ALICE, 'USDT'))).amount;

    // Six attempts. The first already clears the breaker from the basis
    // (2100bps) and is refused; each later one is under 2000bps from the ATTEMPT
    // BEFORE IT, so a basis that moved on a refusal would let the whole
    // staircase through and pay out at 287. None of them move it.
    for (const step of ['121', '144', '171', '203', '241', '287']) {
      feed(step);
      await expect(positions.close(ALICE, pos.id!)).rejects.toMatchObject({ code: 'trade.mark_unusable' });
    }
    expect(formatAmount((await ledger.balance(profitPot())).amount)).toBe('1000000');
    expect((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount).toBe(userAfterOpen);

    const [row] = await sql<{ accepted_mark: string }[]>`SELECT accepted_mark FROM trade.positions WHERE id = ${pos.id!}`;
    expect(formatAmount(amt(row!.accepted_mark))).toBe('100');
  });

  /**
   * The other direction, and the one that decides whether this is a control or
   * a trap: the breaker gates PAYOUTS. A trader whose position moved against
   * them still gets out, because a losing close pays nothing out of any pot.
   */
  it('a losing close is never held by the breaker — it guards payouts, not exits', async () => {
    feed('10000');
    const pos = await positions.open({
      clientOpenId: 't-open-position-service.test-28',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    feed('9000');
    await positions.close(ALICE, pos.id!);
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('99000');
    expect(await positions.listOpen(ALICE)).toEqual([]);
  });

  // ── D-S-07: the mid is not size-blind ────────────────────────────────────────

  /** A service priced off the MATCHING BOOK — the production depth mark path. */
  function onDepth(readDepth: () => Promise<EngineDepth | null>) {
    return new PositionService(sql, ledger, {
      marks: markSourceFromDepth(readDepth),
      profitSource: profitSourceFromConfig(PROFIT_SOURCE),
      maxLeverage: TEST_MAX_LEVERAGE_AMOUNT,
      bus,
      now: () => NOW,
    });
  }

  /**
   * THE SECOND DEFECT, STATED IN BALANCES.
   *
   * `bestFromDepth` read the PRICE at each best level and discarded the
   * QUANTITY, so two 1-wei orders minted a payout-grade `mid`. Measured on this
   * exact scenario before the fix: Alice's available went 100,000 → 102,000 and
   * the profit pot went 10,000 → 8,000. **2,000 USDT paid out against a book
   * holding two orders worth about four femto-cents.**
   *
   * The move is 1000bps — deliberately inside the deviation breaker, so this
   * test measures the depth fix and nothing else.
   *
   * REVERT PROOF: put `depth.bids[0]?.[0]` back in `bestFromDepth` and the
   * balance lines below go red.
   */
  it('refuses to pay on a mid minted from two dust orders, and the 2,000 stays in the pot', async () => {
    await fundProfitSource('10000');
    let book: EngineDepth = { bids: [['1999', '10']], asks: [['2001', '10']], sequence: 1 };
    const svc = onDepth(async () => book);

    const pos = await svc.open({
      clientOpenId: 't-open-position-service.test-29',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('10'),
      leverage: amt('1'),
    });
    expect(pos.entryPrice).toBe('2000');
    const userAfterOpen = (await ledger.balance(userAvailable(ALICE, 'USDT'))).amount;

    // Everything real is pulled. What is left is one wei a side, 2 apart.
    book = {
      bids: [['2199', '0.000000000000000001']],
      asks: [['2201', '0.000000000000000001']],
      sequence: 2,
    };
    await expect(svc.close(ALICE, pos.id!)).resolves.toMatchObject({
      status: 'closing',
      closingReason: 'trade.mark_missing',
    });

    expect(formatAmount((await ledger.balance(profitPot())).amount)).toBe('10000');
    expect((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount).toBe(userAfterOpen);
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('20000');
    expect(await svc.listOpen(ALICE)).toHaveLength(1);
    expect((await svc.listOpen(ALICE))[0]!.status).toBe('closing');
  });

  /**
   * Same prices, real size. The refusal is about DEPTH, not about the prices —
   * otherwise it would be a rule against profitable closes.
   */
  it('the same two prices with real size behind them do pay out', async () => {
    await fundProfitSource('10000');
    let book: EngineDepth = { bids: [['1999', '10']], asks: [['2001', '10']], sequence: 1 };
    const svc = onDepth(async () => book);
    const pos = await svc.open({
      clientOpenId: 't-open-position-service.test-30',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('10'),
      leverage: amt('1'),
    });

    book = { bids: [['2199', '10']], asks: [['2201', '10']], sequence: 2 };
    await svc.close(ALICE, pos.id!);
    // 100000 - 20000 margin + 20000 back + 10 * (2200 - 2000) = 102000
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('102000');
    expect(formatAmount((await ledger.balance(profitPot())).amount)).toBe('8000');
  });

  /** A thin book cannot even OPEN a position — no entry price is minted from dust. */
  it('refuses to OPEN on a dust book, and locks nothing', async () => {
    const svc = onDepth(async () => ({
      bids: [['1999', '0.000000000000000001']],
      asks: [['2001', '0.000000000000000001']],
      sequence: 1,
    }));
    const before = (await ledger.balance(userAvailable(ALICE, 'USDT'))).amount;
    await expect(
      svc.open({
        clientOpenId: 't-open-position-service.test-31',
        userId: ALICE,
        symbol: 'BTC/USDT-PERP',
        side: 'long',
        size: amt('10'),
        leverage: amt('1'),
      }),
    ).rejects.toMatchObject({ code: 'trade.mark_missing' });
    expect((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount).toBe(before);
    expect(await svc.listOpen(ALICE)).toEqual([]);
  });

  // ── D-S-07: the breaker on the LIQUIDATION path, against the real schema ─────

  /**
   * The tick wired the way `futures-jobs.ts` wires it — the SQL loader, the SQL
   * closer and `sqlAcceptedMarkStore` reading the same `trade.positions` row
   * `open()` wrote. That wiring is the fix: `previousMarkFor` was optional,
   * this call site never passed it, and so `acceptableForLiquidation` received
   * `null` for every position on every tick and the breaker never fired once.
   */
  function tick() {
    return runLiquidationTick({
      marks: marks.source(),
      positions: sqlLiquidationPositionLoader(sql),
      closer: sqlPositionCloser(sql, null),
      attempts: memoryLiquidationAttemptStore(),
      acceptedMarks: sqlAcceptedMarkStore(sql),
      ledger,
      now: () => NOW,
      ladder: {
        depth: {
          async depthNotional() {
            return amt('1000000');
          },
        },
        reducer: sqlPositionReducer(sql),
        // 600 bps of notional: mark 95 (equity 50) seizes; 115+ walk stays healthy.
        policy: {
          tiers: [{ uptoDepthBps: Number.MAX_SAFE_INTEGER, maintenanceBps: 600 }],
          marginCallBps: 12_000,
          targetBps: 15_000,
          maxTrancheBps: 10_000,
        },
      },
    });
  }

  /**
   * entry 100, size 10, leverage 10 → margin 100, maintenance 50 (named 5000 bps
   * fixture on the tick; omitted MM no longer invents 50%).
   * At mark 95 equity is exactly 50 and it liquidates.
   */
  async function marginal() {
    feed('100');
    return positions.open({
      clientOpenId: 't-open-position-service.test-32',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('10'),
      leverage: amt('10'),
    });
  }

  it('the tick liquidates on a mark inside the breaker (the control)', async () => {
    const pos = await marginal();
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('100');

    feed('95');
    const result = await tick();
    expect(result.liquidated).toBe(1);
    // THE BALANCES: 50 of margin absorbed the loss, 50 came back.
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('99950');
    expect(await positions.listOpen(ALICE)).toEqual([]);
  });

  /**
   * REVERT PROOF for the tick half. Restore `previousMarkFor?:` and the
   * `?? null` at the call site — or simply stop passing `acceptedMarks` here —
   * and the collateral balance below goes to '0' instead of staying at '100'.
   */
  it('the tick does not seize a position through a 99% mark collapse, and the collateral stays put', async () => {
    const pos = await marginal();

    // 100 → 1. A feed that did this is broken, and a broken feed must not be
    // allowed to close somebody's position on the strength of it.
    feed('1');
    const result = await tick();
    expect(result.liquidated).toBe(0);
    expect(result.items[0]!.outcome).toBe('skipped_mark_unusable');
    expect(result.items[0]!.summary).toContain('not liquidating through it');

    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('100');
    expect(await positions.listOpen(ALICE)).toHaveLength(1);
  });

  /**
   * The basis WALKS. A tick that accepts a mark records it, so an honest market
   * that moves 19% a tick is never mistaken for one impossible jump — which is
   * what makes refusing the jump affordable in the first place.
   */
  it('an accepted mark becomes the next basis, so an honest market can walk anywhere', async () => {
    const pos = await marginal();
    const acceptedMarks = sqlAcceptedMarkStore(sql);

    // Three healthy ticks, each inside the breaker relative to the last.
    for (const step of ['115', '132', '151']) {
      feed(step);
      const result = await runLiquidationTick({
        marks: marks.source(),
        positions: sqlLiquidationPositionLoader(sql),
        closer: sqlPositionCloser(sql, null),
        attempts: memoryLiquidationAttemptStore(),
        acceptedMarks,
        ledger,
        now: () => NOW,
        ladder: {
          depth: {
            async depthNotional() {
              return amt('1000000');
            },
          },
          reducer: sqlPositionReducer(sql),
          policy: {
            tiers: [{ uptoDepthBps: Number.MAX_SAFE_INTEGER, maintenanceBps: 600 }],
            marginCallBps: 12_000,
            targetBps: 15_000,
            maxTrancheBps: 10_000,
          },
        },
      });
      expect(result.items[0]!.outcome).toBe('skipped_healthy');
    }

    const previous = await acceptedMarks.previous(pos.id!);
    expect(previous.kind).toBe('accepted');
    expect(formatAmount(previous.kind === 'accepted' ? previous.price : 0n)).toBe('151');

    // Nothing was seized on the way, and the position is still open at 151 —
    // a 51% cumulative move that never once looked like a jump.
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('100');
    expect(await positions.listOpen(ALICE)).toHaveLength(1);
  });

  /** A REFUSED mark is not recorded — the same no-ratchet rule as the close path. */
  it('a refused mark does not become the basis on the tick path either', async () => {
    const pos = await marginal();
    const acceptedMarks = sqlAcceptedMarkStore(sql);

    feed('1');
    await runLiquidationTick({
      marks: marks.source(),
      positions: sqlLiquidationPositionLoader(sql),
      closer: sqlPositionCloser(sql, null),
      attempts: memoryLiquidationAttemptStore(),
      acceptedMarks,
      ledger,
      now: () => NOW,
    });

    const previous = await acceptedMarks.previous(pos.id!);
    expect(formatAmount(previous.kind === 'accepted' ? previous.price : 0n)).toBe('100');
  });

  // ── Exit-when-dark: liq + funding skip `closing` through public loaders ─────

  it('liquidation tick skips a closing row that would otherwise be seized', async () => {
    const pos = await marginal();
    marks.clear(MARKET);
    const frozen = await positions.close(ALICE, pos.id!);
    expect(frozen.status).toBe('closing');

    // Mark that would liquidate an open marginal long — loader must not see closing.
    feed('95');
    const result = await tick();
    expect(result.scanned).toBe(0);
    expect(result.liquidated).toBe(0);
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('100');
    expect((await positions.listOpen(ALICE))[0]!.status).toBe('closing');
  });

  it('funding tick accrues nothing on a closing position across a period', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-open-position-service.test-33',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    marks.clear(MARKET);
    await positions.close(ALICE, pos.id!);

    const result = await runFundingTick(
      {
        rates: {
          async quote() {
            return { marketId: MARKET, rate: '0.01', periodId: `${MARKET}:dark-period` };
          },
        },
        positions: sqlFundingPositionLoader(sql),
        periods: sqlFundingPeriodStore(sql),
        margins: sqlFundingMarginApplier(sql),
        maxAbsRate: '1', // test fixture only — not product law (D2)
        ledger,
        now: () => NOW,
      },
      MARKET,
    );
    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') expect(result.reason).toBe('no_positions');

    // Collateral untouched — no funding recipe posted against this position.
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('5000');
    expect((await positions.listOpen(ALICE))[0]!.status).toBe('closing');
  });

  it('in-cap re-leverage posts ledger for the isolated margin delta', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-set-leverage-in-cap',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    expect(pos.initialMargin).toBe('5000');
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('95000');

    const next = await positions.setLeverage({
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      positionId: pos.id!,
      leverage: amt('5'),
    });
    expect(next.leverage).toBe('5');
    expect(next.initialMargin).toBe('10000');
    expect(next.collateral).toBe('10000');
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('90000');
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('10000');
  });

  it('a lost successful response replays the stored result without advancing sequence or moving margin twice', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-set-leverage-response-loss',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    const input = {
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      positionId: pos.id!,
      leverage: amt('5'),
      clientAdjustmentId: 'response-loss-1',
    };
    const first = await positions.setLeverage(input);
    const replay = await positions.setLeverage(input);
    expect(replay).toEqual(first);
    await expect(positions.setLeverage({ ...input, leverage: amt('4') })).rejects.toMatchObject({
      code: 'trade.idempotency_conflict',
      status: 409,
    });
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('10000');
    const [stored] = await sql<{ margin_adjust_seq: number; completed: number; result_type: string; collateral: string }[]>`
      SELECT p.margin_adjust_seq,
        (SELECT count(*)::int FROM trade.position_margin_adjustments a
          WHERE a.position_id = p.id AND a.status = 'completed') AS completed,
        jsonb_typeof(a.result) AS result_type,
        a.result->>'collateral' AS collateral
      FROM trade.positions p
      JOIN trade.position_margin_adjustments a ON a.position_id = p.id
        AND a.client_adjustment_id = ${input.clientAdjustmentId}
      WHERE p.id = ${pos.id!}
    `;
    expect(stored).toEqual({ margin_adjust_seq: 2, completed: 1, result_type: 'object', collateral: '10000' });
  });

  it('concurrent identical caller keys serialize to one ledger movement and one stored completion', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-set-leverage-concurrent-key',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    const input = {
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      positionId: pos.id!,
      leverage: amt('5'),
      clientAdjustmentId: 'concurrent-same-1',
    };
    const [a, b] = await Promise.all([positions.setLeverage(input), positions.setLeverage(input)]);
    expect(a).toEqual(b);
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('10000');
    const [stored] = await sql<{ margin_adjust_seq: number; completed: number }[]>`
      SELECT p.margin_adjust_seq,
        (SELECT count(*)::int FROM trade.position_margin_adjustments a
          WHERE a.position_id = p.id AND a.status = 'completed') AS completed
      FROM trade.positions p WHERE p.id = ${pos.id!}
    `;
    expect(stored).toEqual({ margin_adjust_seq: 2, completed: 1 });
  });

  it('ledger success plus DB-finalize failure resumes the same intent exactly once and blocks a different target', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-set-leverage-durable-intent',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    let crashOnce = true;
    const crashing = new PositionService(sql, ledger, {
      marks: marks.source(),
      profitSource: profitSourceFromConfig(PROFIT_SOURCE),
      maxLeverage: TEST_MAX_LEVERAGE_AMOUNT,
      bus,
      now: () => NOW,
      afterMarginLedgerPost: async () => {
        if (crashOnce) {
          crashOnce = false;
          throw new Error('simulated DB finalize failure after ledger acceptance');
        }
      },
    });

    await expect(crashing.setLeverage({ userId: ALICE, symbol: 'BTC/USDT-PERP', positionId: pos.id!, leverage: amt('5') })).rejects.toThrow(
      'simulated DB finalize failure',
    );
    expect((await positions.get(ALICE, pos.id!)).leverage).toBe('10');
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('10000');

    await expect(
      crashing.setLeverage({ userId: ALICE, symbol: 'BTC/USDT-PERP', positionId: pos.id!, leverage: amt('4') }),
    ).rejects.toMatchObject({ code: 'trade.margin_adjustment_in_progress', status: 409 });
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('10000');

    const resumed = await crashing.setLeverage({
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      positionId: pos.id!,
      leverage: amt('5'),
    });
    expect(resumed.leverage).toBe('5');
    expect(resumed.collateral).toBe('10000');
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('10000');
    const [stored] = await sql<{ margin_adjust_request: string | null }[]>`
      SELECT margin_adjust_request FROM trade.positions WHERE id = ${pos.id!}
    `;
    expect(stored!.margin_adjust_request).toBeNull();
  });

  it('re-leverage above the sealed 10× cap is 400 and does not write', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-set-leverage-cap',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    await expect(
      positions.setLeverage({
        userId: ALICE,
        symbol: 'BTC/USDT-PERP',
        positionId: pos.id!,
        leverage: amt('20'),
      }),
    ).rejects.toMatchObject({ code: 'trade.leverage_too_high', status: 400 });
    expect((await positions.listOpen(ALICE))[0]!.leverage).toBe('10');
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('95000');
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('5000');
  });

  it('re-leverage of a missing position is 404', async () => {
    await expect(
      positions.setLeverage({
        userId: ALICE,
        symbol: 'BTC/USDT-PERP',
        positionId: '00000000-0000-4000-8000-000000000099',
        leverage: amt('5'),
      }),
    ).rejects.toMatchObject({ code: 'trade.position_not_found', status: 404 });
  });

  it('insufficient margin refuses re-leverage with no ledger or row write', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-set-leverage-broke',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    await ledger.post(
      recipes.futuresMarginLock({
        positionId: `drain-${randomUUID()}`,
        userId: ALICE,
        assetId: 'USDT',
        amount: amt('94900'),
      }),
    );
    await expect(
      positions.setLeverage({
        userId: ALICE,
        symbol: 'BTC/USDT-PERP',
        positionId: pos.id!,
        leverage: amt('1'),
      }),
    ).rejects.toMatchObject({ code: 'trade.insufficient_margin', status: 400 });
    const listed = await positions.listOpen(ALICE);
    expect(listed[0]!.leverage).toBe('10');
    expect(listed[0]!.initialMargin).toBe('5000');
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('5000');
  });

  it('would-be liquidation refuses re-leverage with no ledger or row write', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-set-leverage-would-liq',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('2'),
    });
    feed('30000');
    await expect(
      positions.setLeverage({
        userId: ALICE,
        symbol: 'BTC/USDT-PERP',
        positionId: pos.id!,
        leverage: amt('10'),
      }),
    ).rejects.toMatchObject({ code: 'trade.leverage_would_liquidate', status: 400 });
    expect((await positions.listOpen(ALICE))[0]!.leverage).toBe('2');
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('25000');
  });

  it('isolated margin add posts futuresMarginAdd and leaves leverage unchanged', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-add-isolated-margin',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    expect(pos.collateral).toBe('5000');
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('95000');

    const next = await positions.addIsolatedMargin({
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      positionId: pos.id!,
      amount: amt('2500'),
    });
    expect(next.leverage).toBe('10');
    expect(next.initialMargin).toBe('5000');
    expect(next.collateral).toBe('7500');
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('92500');
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('7500');
  });

  it('refuses staked collateral on isolated margin add, and locks nothing extra', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-add-margin-staked-refuse',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    const before = (await ledger.balance(userAvailable(ALICE, 'USDT'))).amount;
    await expect(
      positions.addIsolatedMargin({
        userId: ALICE,
        symbol: 'BTC/USDT-PERP',
        positionId: pos.id!,
        amount: amt('2500'),
        collateralClass: 'staked',
      }),
    ).rejects.toMatchObject({ code: 'trade.unsupported_collateral_class' });
    expect((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount).toBe(before);
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('5000');
  });

  it('margin add survives finalize failure, concurrent identical retry, and successful-response replay exactly once', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-add-margin-delta-retries',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    let crashOnce = true;
    const crashing = new PositionService(sql, ledger, {
      marks: marks.source(),
      profitSource: profitSourceFromConfig(PROFIT_SOURCE),
      maxLeverage: TEST_MAX_LEVERAGE_AMOUNT,
      bus,
      now: () => NOW,
      afterMarginLedgerPost: async () => {
        if (crashOnce) {
          crashOnce = false;
          throw new Error('simulated add finalize failure');
        }
      },
    });
    const input = {
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      positionId: pos.id!,
      amount: amt('2500'),
      clientAdjustmentId: 'add-delta-retry-1',
    };

    await expect(crashing.addIsolatedMargin(input)).rejects.toThrow('simulated add finalize failure');
    expect((await positions.get(ALICE, pos.id!)).collateral).toBe('5000');
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('7500');

    const [a, b] = await Promise.all([crashing.addIsolatedMargin(input), crashing.addIsolatedMargin(input)]);
    expect(a).toEqual(b);
    expect((await crashing.addIsolatedMargin(input)).collateral).toBe('7500');
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('7500');
    const [stored] = await sql<{ margin_adjust_seq: number; completed: number }[]>`
      SELECT p.margin_adjust_seq,
        (SELECT count(*)::int FROM trade.position_margin_adjustments a
          WHERE a.position_id = p.id AND a.status = 'completed') AS completed
      FROM trade.positions p WHERE p.id = ${pos.id!}
    `;
    expect(stored).toEqual({ margin_adjust_seq: 2, completed: 1 });
  });

  it('margin add replays its stored old response after a later add while preserving the newer ledger state', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-add-margin-historical-result',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    const common = { userId: ALICE, symbol: 'BTC/USDT-PERP', positionId: pos.id! };
    const oldInput = { ...common, amount: amt('1000'), clientAdjustmentId: 'add-historical-old' };
    const oldResult = await positions.addIsolatedMargin(oldInput);
    expect(oldResult.collateral).toBe('6000');

    const newer = await positions.addIsolatedMargin({
      ...common,
      amount: amt('500'),
      clientAdjustmentId: 'add-historical-new',
    });
    expect(newer.collateral).toBe('6500');

    const replay = await positions.addIsolatedMargin(oldInput);
    expect(replay).toEqual(oldResult);
    await expect(positions.addIsolatedMargin({ ...oldInput, amount: amt('999') })).rejects.toMatchObject({
      code: 'trade.idempotency_conflict',
      status: 409,
    });
    expect((await positions.get(ALICE, pos.id!)).collateral).toBe('6500');
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('6500');
    const [stored] = await sql<{ result_type: string; collateral: string }[]>`
      SELECT jsonb_typeof(result) AS result_type, result->>'collateral' AS collateral
      FROM trade.position_margin_adjustments
      WHERE position_id = ${pos.id!} AND client_adjustment_id = ${oldInput.clientAdjustmentId}
    `;
    expect(stored).toEqual({ result_type: 'object', collateral: '6000' });
  });

  it('isolated margin add of a missing position is 404', async () => {
    await expect(
      positions.addIsolatedMargin({
        userId: ALICE,
        symbol: 'BTC/USDT-PERP',
        positionId: '00000000-0000-4000-8000-000000000099',
        amount: amt('1'),
      }),
    ).rejects.toMatchObject({ code: 'trade.position_not_found', status: 404 });
  });

  it('insufficient available refuses isolated margin add with no ledger or row write', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-add-isolated-broke',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    await ledger.post(
      recipes.futuresMarginLock({
        positionId: `drain-${randomUUID()}`,
        userId: ALICE,
        assetId: 'USDT',
        amount: amt('94900'),
      }),
    );
    await expect(
      positions.addIsolatedMargin({
        userId: ALICE,
        symbol: 'BTC/USDT-PERP',
        positionId: pos.id!,
        amount: amt('200'),
      }),
    ).rejects.toMatchObject({ code: 'trade.insufficient_margin', status: 400 });
    const listed = await positions.listOpen(ALICE);
    expect(listed[0]!.leverage).toBe('10');
    expect(listed[0]!.collateral).toBe('5000');
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('5000');
  });

  it('zero isolated margin add is 400 and does not write', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-add-isolated-zero',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    await expect(
      positions.addIsolatedMargin({
        userId: ALICE,
        symbol: 'BTC/USDT-PERP',
        positionId: pos.id!,
        amount: amt('0'),
      }),
    ).rejects.toMatchObject({ code: 'trade.bad_request', status: 400 });
    expect((await positions.listOpen(ALICE))[0]!.collateral).toBe('5000');
  });

  it('isolated margin reduce posts futuresMarginRelease and leaves leverage unchanged', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-reduce-isolated-margin',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    await positions.addIsolatedMargin({
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      positionId: pos.id!,
      amount: amt('2500'),
    });
    const next = await positions.reduceIsolatedMargin({
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      positionId: pos.id!,
      amount: amt('2500'),
    });
    expect(next.leverage).toBe('10');
    expect(next.initialMargin).toBe('5000');
    expect(next.collateral).toBe('5000');
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('95000');
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('5000');
  });

  it('margin reduce survives finalize failure, concurrent identical retry, and successful-response replay exactly once', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-reduce-margin-delta-retries',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    await positions.addIsolatedMargin({
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      positionId: pos.id!,
      amount: amt('2500'),
      clientAdjustmentId: 'reduce-setup-add',
    });
    let crashOnce = true;
    const crashing = new PositionService(sql, ledger, {
      marks: marks.source(),
      profitSource: profitSourceFromConfig(PROFIT_SOURCE),
      maxLeverage: TEST_MAX_LEVERAGE_AMOUNT,
      bus,
      now: () => NOW,
      afterMarginLedgerPost: async () => {
        if (crashOnce) {
          crashOnce = false;
          throw new Error('simulated reduce finalize failure');
        }
      },
    });
    const input = {
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      positionId: pos.id!,
      amount: amt('2500'),
      clientAdjustmentId: 'reduce-delta-retry-1',
    };

    await expect(crashing.reduceIsolatedMargin(input)).rejects.toThrow('simulated reduce finalize failure');
    expect((await positions.get(ALICE, pos.id!)).collateral).toBe('7500');
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('5000');

    const [a, b] = await Promise.all([crashing.reduceIsolatedMargin(input), crashing.reduceIsolatedMargin(input)]);
    expect(a).toEqual(b);
    expect((await crashing.reduceIsolatedMargin(input)).collateral).toBe('5000');
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('5000');
    const [stored] = await sql<{ margin_adjust_seq: number; completed: number }[]>`
      SELECT p.margin_adjust_seq,
        (SELECT count(*)::int FROM trade.position_margin_adjustments a
          WHERE a.position_id = p.id AND a.status = 'completed') AS completed
      FROM trade.positions p WHERE p.id = ${pos.id!}
    `;
    expect(stored).toEqual({ margin_adjust_seq: 3, completed: 2 });
  });

  it('margin reduce replays its stored old response after a later reduce while preserving the newer ledger state', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-reduce-margin-historical-result',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    const common = { userId: ALICE, symbol: 'BTC/USDT-PERP', positionId: pos.id! };
    await positions.addIsolatedMargin({ ...common, amount: amt('3000'), clientAdjustmentId: 'reduce-history-setup' });
    const oldInput = { ...common, amount: amt('1000'), clientAdjustmentId: 'reduce-historical-old' };
    const oldResult = await positions.reduceIsolatedMargin(oldInput);
    expect(oldResult.collateral).toBe('7000');

    const newer = await positions.reduceIsolatedMargin({
      ...common,
      amount: amt('500'),
      clientAdjustmentId: 'reduce-historical-new',
    });
    expect(newer.collateral).toBe('6500');

    const replay = await positions.reduceIsolatedMargin(oldInput);
    expect(replay).toEqual(oldResult);
    await expect(positions.reduceIsolatedMargin({ ...oldInput, amount: amt('999') })).rejects.toMatchObject({
      code: 'trade.idempotency_conflict',
      status: 409,
    });
    expect((await positions.get(ALICE, pos.id!)).collateral).toBe('6500');
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('6500');
    const [stored] = await sql<{ result_type: string; collateral: string }[]>`
      SELECT jsonb_typeof(result) AS result_type, result->>'collateral' AS collateral
      FROM trade.position_margin_adjustments
      WHERE position_id = ${pos.id!} AND client_adjustment_id = ${oldInput.clientAdjustmentId}
    `;
    expect(stored).toEqual({ result_type: 'object', collateral: '7000' });
  });

  it('binds each caller key to one operation and payload across set, add, and reduce', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-margin-cross-operation-keys',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    const common = { userId: ALICE, symbol: 'BTC/USDT-PERP', positionId: pos.id! };

    await positions.setLeverage({ ...common, leverage: amt('5'), clientAdjustmentId: 'shared-set-key' });
    await expect(positions.addIsolatedMargin({ ...common, amount: amt('1'), clientAdjustmentId: 'shared-set-key' })).rejects.toMatchObject({
      code: 'trade.idempotency_conflict',
      status: 409,
    });
    await expect(
      positions.reduceIsolatedMargin({ ...common, amount: amt('1'), clientAdjustmentId: 'shared-set-key' }),
    ).rejects.toMatchObject({ code: 'trade.idempotency_conflict', status: 409 });

    await positions.addIsolatedMargin({ ...common, amount: amt('1'), clientAdjustmentId: 'shared-add-key' });
    await expect(
      positions.reduceIsolatedMargin({ ...common, amount: amt('1'), clientAdjustmentId: 'shared-add-key' }),
    ).rejects.toMatchObject({ code: 'trade.idempotency_conflict', status: 409 });
    await expect(positions.setLeverage({ ...common, leverage: amt('4'), clientAdjustmentId: 'shared-add-key' })).rejects.toMatchObject({
      code: 'trade.idempotency_conflict',
      status: 409,
    });

    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('10001');
    expect((await positions.get(ALICE, pos.id!)).collateral).toBe('10001');
  });

  it('isolated margin reduce below initial is 400 and does not write', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-reduce-isolated-below-im',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    await expect(
      positions.reduceIsolatedMargin({
        userId: ALICE,
        symbol: 'BTC/USDT-PERP',
        positionId: pos.id!,
        amount: amt('1'),
      }),
    ).rejects.toMatchObject({ code: 'trade.margin_below_initial', status: 400 });
    expect((await positions.listOpen(ALICE))[0]!.collateral).toBe('5000');
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('5000');
  });

  it('would-be liquidation refuses isolated margin reduce with no ledger or row write', async () => {
    feed('50000');
    const pos = await positions.open({
      clientOpenId: 't-reduce-isolated-would-liq',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('2'),
    });
    await positions.addIsolatedMargin({
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      positionId: pos.id!,
      amount: amt('1000'),
    });
    feed('24500');
    await expect(
      positions.reduceIsolatedMargin({
        userId: ALICE,
        symbol: 'BTC/USDT-PERP',
        positionId: pos.id!,
        amount: amt('1000'),
      }),
    ).rejects.toMatchObject({ code: 'trade.margin_would_liquidate', status: 400 });
    expect((await positions.listOpen(ALICE))[0]!.collateral).toBe('26000');
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).amount)).toBe('26000');
  });
});
