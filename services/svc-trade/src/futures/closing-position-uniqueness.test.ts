import { PositionService } from '../controls/test-admission.js';
/**
 * THE UNIQUE INDEX ON OPEN POSITIONS SAYS `status = 'open'`, AND IT MEANS IT.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS FOUND
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `0003_trade_futures_positions.sql:50`:
 *
 *     CREATE UNIQUE INDEX positions_open_unique_idx
 *       ON trade.positions (user_id, market_id, side, margin_mode)
 *       WHERE status = 'open';
 *
 * Migrations `0008` / `0009` added a FOURTH status, `closing` — the dark-feed
 * freeze from `docs/adr/2026-08-07-futures-exit-when-the-feed-is-dark.md` — and
 * left that predicate alone. So:
 *
 *     Alice opens a long on BTC-PERP
 *       → the feed goes dark
 *       → she closes; the row freezes to `closing`
 *       → the feed returns
 *       → she opens a SECOND long on BTC-PERP, and it succeeds.
 *
 * `listOpen` then returns two rows: `['closing', 'open']`.
 *
 * `#1103`'s migration `0015` reviewed this very index and wrote a paragraph
 * about it — but only about the `margin_mode` column, concluding correctly that
 * the column is harmless. Nobody looked at the predicate. The FIRST test below
 * is that reproduction, run through the real service.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DECISION: THE PREDICATE STAYS. THE INVARIANT WAS ALWAYS NARROWER THAN THE
 * INDEX'S NAME SUGGESTS, AND `0016` NOW SAYS SO IN THE SCHEMA.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The tempting fix is `WHERE status IN ('open', 'closing')` — "one LIVE position
 * per (user, market, side, margin_mode)". It is the wrong fix, for one reason
 * that is already settled law here and three that are measurable.
 *
 * **The settled one.** A `closing` row exists for exactly one reason: OUR feed
 * went dark while a trader was trying to leave. ADR 2026-08-07 ruled that *the
 * platform's outage is not the trader's risk*, and that *a control which traps
 * funds is not a safety control*. Tightening the predicate would charge our
 * outage to the trader a second time: locked out of that market and side until
 * a feed we broke comes back. There is no automatic settlement tick — a
 * `closing` row settles only when someone calls `close()` again and a usable
 * mark exists — so the lockout has no bound the trader controls. That is the
 * same trap the ADR was written to remove, rebuilt one layer down in storage.
 *
 * **Measured, not assumed** — the three hazards a tightened predicate would be
 * guarding against do not exist in this codebase, and the tests below check each:
 *
 *   1. *Double-counted margin.* Isolated margin only (`0015`). Each position
 *      holds its own ledger pot `position:<id>`, drawn from the same finite
 *      `userAvailable`. The second open must FUND itself — asserted below by
 *      balance, not by status code. Row count is not the binding constraint on
 *      exposure; the trader's balance is, and it is unchanged by this carve-out.
 *   2. *Confused liquidation.* `sqlLiquidationPositionLoader` filters
 *      `status = 'open'`, so the `closing` row is never scanned. The new `open`
 *      row is evaluated against its own isolated margin, alone.
 *   3. *Confused funding.* `sqlFundingPositionLoader` filters `status = 'open'`
 *      too, so the frozen row accrues nothing — ADR done-bar item 4.
 *
 * Nothing in `svc-trade` resolves a position by `(user, market, side)`; every
 * read, lock, ledger key and idempotency key is by position id. Two rows on one
 * market and side are therefore two independent settlements, not one ambiguous
 * one.
 *
 * **The trade-off accepted.** A trader CAN, during a long outage, cycle
 * close→open→close→open and accumulate several frozen rows on one market and
 * side. That is real and it is the price of this decision. It is bounded by
 * their own free balance — each open posts fresh margin — and each frozen row
 * settles independently against a profit pot whose bound is re-read live at
 * every close, so N small settlements drain it exactly as one large one would.
 * The alternative price was trapping a trader in a market because of our
 * outage, and this repo has already ruled which of those two it will pay.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REVERT PROOF
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Each of these was RUN, not reasoned about; the counts are measured.
 *
 * · Tighten the predicate to `IN ('open','closing')` via a later migration — 6 of
 *   7 red. The reproduction fails with `duplicate key value violates unique
 *   constraint "positions_open_unique_idx"` on the trader's new open, which is
 *   the lockout of the header, observed rather than argued.
 * · Drop `positions_open_unique_idx` — 3 red, including `two OPEN rows are still
 *   refused`: the invariant that IS real stops being enforced.
 * · Put `closing` back into `sqlLiquidationPositionLoader` — 1 red (`the
 *   liquidation scan never sees the frozen row`). Same for the funding loader,
 *   1 red. Those two filters are PRECONDITIONS of the carve-out, not unrelated
 *   details, and this is what says so.
 * · Revert migration `0016` — 1 red, and it is the LAST test in this file, the
 *   one that checks the comment exists. Stated plainly rather than dressed up:
 *   `0016` is documentation as DDL, so the only assertion it can break is the
 *   assertion that the documentation is there. Every BEHAVIOURAL test in this
 *   file passes with `0016` absent. The tests are the guard; the migration is
 *   the reason, parked where the next reviewer will trip over it.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run `createTestDatabase`, not shared table mutations).
 * Local without that env starts Testcontainers `postgres:16-alpine`. Docker/PG
 * down is a failed suite, not a green skip.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';

import { memoryMarkBook } from './mark-source.js';
import { formatAccountRef, profitSourceFromConfig, recipeProfitFundingAccount } from './profit-source.js';
import { TEST_MAX_LEVERAGE_AMOUNT } from './initial-margin.test-harness.js';
import { sqlFundingPositionLoader, sqlLiquidationPositionLoader } from './position-loaders.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';
const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-08-08T12:00:00.000Z');
const PROFIT_SOURCE = formatAccountRef(recipeProfitFundingAccount('USDT'));

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
      `H8a: svc-trade closing-position-uniqueness is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('closing positions and the open-unique index (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('closing positions and the open-unique index', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];

  let ledger: MemoryLedger;
  let marks: ReturnType<typeof memoryMarkBook>;
  let service: PositionService;

  /** Lit feed. */
  const feed = (price: string) => marks.set({ marketId: MARKET, price, quality: 'mid', asOfMs: NOW.getTime() });
  /** Dark feed — no quote at all, which is `trade.mark_missing`. */
  const dark = () => marks.clear(MARKET);

  const available_ = async () => formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount);

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await sql`TRUNCATE trade.positions, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    marks = memoryMarkBook();
    await sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (
        ${MARKET}, 'BTC/USDT-PERP', 'BTC', 'USDT', 'futures',
        '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'BTC perpetual', now()
      )
    `;
    await ledger.post(
      recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('100000'), rail: 'test', railRef: `fund-${randomUUID()}` }),
    );
    service = new PositionService(sql, ledger, {
      marks: marks.source(),
      profitSource: profitSourceFromConfig(PROFIT_SOURCE),
      maxLeverage: TEST_MAX_LEVERAGE_AMOUNT,
      bus: null,
      now: () => NOW,
    });
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  let openSeq = 0;
  const openLong = () =>
    service.open({
      // Unique each call — same key would re-read the first row (retry path).
      clientOpenId: `t-open-closing-position-uniqueness.test-${++openSeq}`,
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });

  /**
   * THE REPRODUCTION, through the real service and the real migrations.
   *
   * open → freeze → open again. Asserted as behaviour that HOLDS, because the
   * decision is that it should: see the header. If a later change makes this
   * red, that change is re-deciding ADR 2026-08-07 and needs to say so.
   */
  it('open → dark-feed freeze → open again: a second position on the same market and side is ALLOWED', async () => {
    feed('50000');
    const first = await openLong();
    expect(first.status).toBe('open');

    dark();
    const frozen = await service.close(ALICE, first.id!);
    expect(frozen.status).toBe('closing');
    expect(frozen.closingReason).toBe('trade.mark_missing');

    feed('50000');
    const second = await openLong();
    expect(second.status).toBe('open');
    expect(second.id).not.toBe(first.id);

    const live = await service.listOpen(ALICE);
    expect(live.map((p) => p.status).sort()).toEqual(['closing', 'open']);
  });

  /**
   * Hazard 1, refuted by balance rather than by argument. The second open is not
   * free: it posts its own isolated margin out of the same `userAvailable`. Row
   * count does not multiply exposure — the balance is the binding constraint,
   * and it is exactly as binding with two rows as with one.
   */
  it('the second position funds its own margin — no double count', async () => {
    feed('50000');
    const first = await openLong();
    expect(await available_()).toBe('95000');

    dark();
    await service.close(ALICE, first.id!);
    // Frozen, not settled: the collateral is still held, so nothing came back.
    expect(await available_()).toBe('95000');

    feed('50000');
    await openLong();
    expect(await available_()).toBe('90000');
  });

  /**
   * Hazard 2, and the PRECONDITION that makes the carve-out safe. Restore
   * `closing` to this loader and a frozen row becomes liquidatable next to a
   * live one on the same market and side — which is the confusion the tightened
   * predicate was meant to prevent, arriving by the door that was actually open.
   */
  it('the liquidation scan never sees the frozen row, even beside a live one', async () => {
    feed('50000');
    const first = await openLong();
    dark();
    await service.close(ALICE, first.id!);
    feed('50000');
    const second = await openLong();

    const scanned = await sqlLiquidationPositionLoader(sql).listOpen();
    expect(scanned.map((p) => p.positionId)).toEqual([second.id]);
  });

  /** Hazard 3, same shape: ADR done-bar item 4 — a frozen position accrues no funding. */
  it('the funding loader never sees the frozen row, even beside a live one', async () => {
    feed('50000');
    const first = await openLong();
    dark();
    await service.close(ALICE, first.id!);
    feed('50000');
    const second = await openLong();

    const funded = await sqlFundingPositionLoader(sql).listOpenForMarket(MARKET);
    expect(funded.map((p) => p.positionId)).toEqual([second.id]);
  });

  /**
   * The invariant that IS real, and the one the index actually buys. Asserted by
   * SQLSTATE and index name, not by message text, so a reworded error does not
   * quietly turn this green.
   */
  it('two OPEN rows on the same (user, market, side, margin_mode) are still refused by the database', async () => {
    feed('50000');
    await openLong();

    const second = sql`
      INSERT INTO trade.positions (
        user_id, market_id, side, margin_mode, status,
        size, entry_price, leverage, margin_initial, margin_current, margin_asset, opened_at
      ) VALUES (
        ${ALICE}, ${MARKET}, 'long', 'isolated', 'open',
        '1', '50000', 10, '5000', '5000', 'USDT', now()
      )
    `;
    await expect(second).rejects.toMatchObject({
      code: '23505',
      constraint_name: 'positions_open_unique_idx',
    });
  });

  /**
   * The predicate is pinned. `0016` argues in prose why it says `open` and not
   * `IN ('open','closing')`; this is the assertion that makes the prose binding.
   * Read from `pg_get_indexdef`, so it reflects what the database actually has
   * after every migration has run — not what the 0003 file says.
   */
  it('pins the predicate: the index covers status = open and nothing else', async () => {
    const [row] = await sql<{ def: string }[]>`
      SELECT pg_get_indexdef(i.indexrelid) AS def
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'trade' AND c.relname = 'positions_open_unique_idx'
    `;
    expect(row).toBeDefined();
    expect(row!.def).toContain('UNIQUE INDEX');
    expect(row!.def).toContain('user_id, market_id, side, margin_mode');
    // `position_status` unqualified: pg_get_indexdef prints the type relative to
    // search_path, and `trade` is on it. Matching loosely on the schema prefix
    // rather than pinning it keeps this about the PREDICATE.
    expect(row!.def).toMatch(/WHERE \(status = 'open'::(?:trade\.)?position_status\)/);
    expect(row!.def).not.toContain('closing');
  });

  /**
   * `0016` is documentation as DDL: the reasoning lands where `\d+
   * trade.positions` and every schema dump will show it, which is where `#1103`'s
   * reviewer was looking when they missed the predicate. Asserted so a silent
   * deletion of the comment is caught, and NOT asserted on wording.
   */
  it('the index carries its decision in the schema, not only in a migration file', async () => {
    const [row] = await sql<{ comment: string | null }[]>`
      SELECT obj_description(c.oid, 'pg_class') AS comment
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'trade' AND c.relname = 'positions_open_unique_idx'
    `;
    expect(row?.comment).toBeTruthy();
    expect(row!.comment).toContain('2026-08-07');
    expect(row!.comment).toContain('closing');
  });
});
