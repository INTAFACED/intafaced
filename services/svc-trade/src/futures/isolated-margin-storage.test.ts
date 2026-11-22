/**
 * ISOLATED MARGIN IS A STORAGE INVARIANT, NOT A SERVICE-LAYER OPINION.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE GAP THIS FILE EXISTS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `DIRECTION` §1 and `docs/adr/2026-08-05-futures-risk-and-mark-law.md` done-bar
 * item 8 both say: isolated margin only, and **no cross-margin path exists, even
 * disabled**. Before migration 0015 the storage layer disagreed with both.
 *
 *   0003_trade_futures_positions.sql:12
 *     CREATE TYPE "trade"."margin_mode" AS ENUM ('cross', 'isolated');
 *   0003_trade_futures_positions.sql:25
 *     "margin_mode" "trade"."margin_mode" NOT NULL DEFAULT 'isolated',
 *
 * `position-service.ts` refuses `marginMode !== 'isolated'` inside `open()`, and
 * that refusal is real. It is also the ONLY thing that was stopping a
 * cross-margin row from existing — so a direct INSERT, a repair script, a
 * restore, a replayed event, or any future code path that builds a row itself
 * would have created one, and nothing would have said so.
 *
 * That shape has now cost this subsystem four findings: the deviation breaker
 * unarmed at every call site, `requirePayoutGrade`'s losing-close exemption
 * sitting behind an earlier throw, #883's profit-source refusal with exactly one
 * legal value, and this. **A rule enforced in one caller is not an invariant.**
 * The DEFAULT made it worse rather than better: it meant an explicit 'cross'
 * was accepted silently instead of rejected, because the default only applies
 * when the column is omitted.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS TEST INSERTS DIRECTLY, WHICH NORMALLY WOULD BE WRONG
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Going through `open()` would prove only that `open()` still refuses — which
 * was never in doubt and is already tested. The defect was everything that does
 * NOT go through `open()`, so the test has to be the thing that does not go
 * through `open()`. It asserts the DATABASE refuses, by catching the constraint
 * violation.
 *
 * Revert proof: drop `ck_positions_isolated_margin_only` (or run
 * `0015_position_isolated_margin_only.down.sql`) and the first test here goes
 * red — the INSERT succeeds and returns a cross-margin row.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run `createTestDatabase`, not shared table mutations).
 * Local without that env starts Testcontainers `postgres:16-alpine`. Docker/PG
 * down is a failed suite, not a green skip.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testPostgres } from '@intafaced/db/test-postgres';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';
const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await testPostgres(H8A_IMAGE)
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
      `H8a: svc-trade isolated-margin-storage is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('isolated margin storage law (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('the database refuses cross margin, not just the service', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await sql`DELETE FROM trade.positions`;
    await sql`DELETE FROM trade.markets`;
    await sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (
        ${MARKET}, 'BTC/USDT-PERP', 'BTC', 'USDT', 'futures',
        '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'BTC perpetual', now()
      )
    `;
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  /** A row that bypasses `open()` entirely — the case the service refusal never saw. */
  const insert = (marginMode: string) => sql`
    INSERT INTO trade.positions (
      user_id, market_id, side, margin_mode, status,
      size, entry_price, leverage, margin_initial, margin_current, margin_asset, opened_at
    ) VALUES (
      ${ALICE}, ${MARKET}, 'long', ${sql.unsafe(`'${marginMode}'`)}, 'open',
      '1', '50000', 5, '10000', '10000', 'USDT', now()
    )
    RETURNING id, margin_mode
  `;

  it('REFUSES a direct insert of a cross-margin position', async () => {
    await expect(insert('cross')).rejects.toMatchObject({
      // 23514 = check_violation. Asserted by code, not by message text, so a
      // reworded constraint does not silently turn this green.
      code: '23514',
      constraint_name: 'ck_positions_isolated_margin_only',
    });

    const rows = await sql<{ n: string }[]>`SELECT count(*) AS n FROM trade.positions`;
    expect(rows[0]!.n).toBe('0');
  });

  it('still accepts isolated margin — this is a constraint, not a ban on futures', async () => {
    const rows = await insert('isolated');

    expect(rows).toHaveLength(1);
    expect(rows[0]!.margin_mode).toBe('isolated');
  });

  it('the enum still carries cross, so the CONSTRAINT is what closes the gap', async () => {
    // If a later migration drops 'cross' from the type this test fails, which
    // is the correct outcome: the reason for keeping the constraint would have
    // changed and this file's argument needs rewriting rather than passing by
    // accident.
    const labels = await sql<{ enumlabel: string }[]>`
      SELECT enumlabel
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typname = 'margin_mode' AND n.nspname = 'trade'
      ORDER BY enumlabel
    `;

    expect(labels.map((r) => r.enumlabel)).toEqual(['cross', 'isolated']);
  });

  it('the constraint is present and not merely assumed by the other tests', async () => {
    const rows = await sql<{ conname: string }[]>`
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'trade' AND t.relname = 'positions' AND c.contype = 'c'
        AND c.conname = 'ck_positions_isolated_margin_only'
    `;

    expect(rows).toHaveLength(1);
  });
});
