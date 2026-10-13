/**
 * A FUNDING PERIOD MOVES A POSITION'S MARGIN EXACTLY ONCE.
 *
 * `runFundingTick` posts to the ledger, applies the margin nets, and only then
 * marks the period settled. The settle marker is written LAST, so a restart in
 * that gap leaves the period unsettled and the next tick re-runs everything
 * above it. The ledger dedupes on its own key and moves no money twice.
 * `margin_current` had no such key, and a bare decrement replayed is a trader's
 * margin charged twice for one funding period — liquidating early, releasing
 * short, and clamped at zero by GREATEST so nothing raised.
 *
 * This suite replays the applier against a real database and asserts the second
 * pass is a no-op. Against a mock it would only assert that statements were
 * issued, which is what the existing tick-stores suite does and why this needed
 * its own file.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run `createTestDatabase`, not shared table mutations).
 * Local without that env starts Testcontainers `postgres:16-alpine`. Docker/PG
 * down is a failed suite, not a green skip.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { formatAmount, parseAmount as amt } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sqlFundingMarginApplier, sqlFundingPeriodStore } from './tick-stores.js';

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
      `H8a: svc-trade funding-margin-idempotency is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ALICE = '11111111-1111-4111-8111-111111111111';
const PERIOD = 'BTC/USDT-PERP:2026-08-08T00:00:00.000Z';

function money(value: string): string {
  return formatAmount(amt(value));
}

describe('funding margin idempotency hitch (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('funding margin idempotency (Postgres)', () => {
  /**
   * `service: 'trade'` — the schema must be named `trade`, because every
   * statement in this service is schema-qualified (`trade.positions`) by §2
   * design. Isolation is at the DATABASE level: `createTestDatabase` mints a
   * uniquely named database per run and creates the schema under its real name
   * inside it, so two suites both asking for `trade` never meet.
   */
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let applier!: ReturnType<typeof sqlFundingMarginApplier>;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
    sql = db.sql;
    applier = sqlFundingMarginApplier(sql);
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  /**
   * One open position with 100 margin, and nothing else.
   *
   * `side` is a parameter because `positions_open_unique_idx` allows a user only
   * one open position per (market, side, margin_mode) — which is also the real
   * shape of a funding period: a long pays and a short receives.
   */
  async function openPosition(side: 'long' | 'short' = 'long'): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO trade.positions (
        user_id, market_id, side, status, margin_mode, size, entry_price, leverage,
        margin_initial, margin_current, margin_asset, funding_paid
      ) VALUES (
        ${ALICE}, ${MARKET}, ${side}, 'open', 'isolated', '1', '50000', '5',
        '100', '100', 'USDT', '0'
      )
      RETURNING id
    `;
    return row!.id;
  }

  async function readPosition(id: string) {
    const [row] = await sql<{ margin_current: string; funding_paid: string }[]>`
      SELECT margin_current, funding_paid FROM trade.positions WHERE id = ${id}
    `;
    return row!;
  }

  beforeEach(async () => {
    await sql`TRUNCATE trade.positions, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    await sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (
        ${MARKET}, 'BTC/USDT-PERP', 'BTC', 'USDT', 'futures',
        '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'BTC Perpetual', now()
      )
    `;
  });

  describe('a payer charged twice for one period', () => {
    it('THE DEFECT: replaying the same period does not charge margin again', async () => {
      const id = await openPosition();

      await applier.applyFundingNets([{ positionId: id, paid: amt('5') }], PERIOD);
      expect(money((await readPosition(id)).margin_current)).toBe('95');

      // The restart. Period was never marked settled, so the tick runs again.
      await applier.applyFundingNets([{ positionId: id, paid: amt('5') }], PERIOD);

      const after = await readPosition(id);
      expect(money(after.margin_current)).toBe('95');
      expect(money(after.funding_paid)).toBe('5');
    });

    it('a genuinely new period still charges', async () => {
      const id = await openPosition();

      await applier.applyFundingNets([{ positionId: id, paid: amt('5') }], PERIOD);
      await applier.applyFundingNets([{ positionId: id, paid: amt('5') }], `${PERIOD}-next`);

      const after = await readPosition(id);
      expect(money(after.margin_current)).toBe('90');
      expect(money(after.funding_paid)).toBe('10');
    });

    it('records what was applied, signed, rather than leaving it to be inferred', async () => {
      const id = await openPosition();
      await applier.applyFundingNets([{ positionId: id, paid: amt('5') }], PERIOD);

      const rows = await sql<{ period_id: string; paid: string }[]>`
        SELECT period_id, paid FROM trade.position_funding_applied WHERE position_id = ${id}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.period_id).toBe(PERIOD);
      expect(money(rows[0]!.paid)).toBe('5');
    });
  });

  describe('a payee receiving funding', () => {
    it('does not double-credit on replay either', async () => {
      const id = await openPosition();

      await applier.applyFundingNets([{ positionId: id, paid: -amt('5') }], PERIOD);
      await applier.applyFundingNets([{ positionId: id, paid: -amt('5') }], PERIOD);

      const after = await readPosition(id);
      // Receipts go to available, not back into margin — margin is untouched.
      expect(money(after.margin_current)).toBe('100');
      expect(money(after.funding_paid)).toBe('-5');
    });

    it('records the receipt as negative', async () => {
      const id = await openPosition();
      await applier.applyFundingNets([{ positionId: id, paid: -amt('5') }], PERIOD);

      const [row] = await sql<{ paid: string }[]>`
        SELECT paid FROM trade.position_funding_applied WHERE position_id = ${id}
      `;
      expect(money(row!.paid)).toBe('-5');
    });
  });

  describe('the edges the guard must not break', () => {
    it('a zero net writes nothing at all', async () => {
      const id = await openPosition();
      await applier.applyFundingNets([{ positionId: id, paid: 0n }], PERIOD);

      const rows = await sql`SELECT 1 FROM trade.position_funding_applied WHERE position_id = ${id}`;
      expect(rows).toHaveLength(0);
      expect(money((await readPosition(id)).margin_current)).toBe('100');
    });

    it('two positions in one period are independent', async () => {
      const a = await openPosition('long');
      const b = await openPosition('short');

      await applier.applyFundingNets(
        [
          { positionId: a, paid: amt('5') },
          { positionId: b, paid: -amt('5') },
        ],
        PERIOD,
      );

      expect(money((await readPosition(a)).margin_current)).toBe('95');
      expect(money((await readPosition(b)).margin_current)).toBe('100');
      expect(money((await readPosition(b)).funding_paid)).toBe('-5');
    });

    it('closing the position takes its funding trail with it', async () => {
      const id = await openPosition();
      await applier.applyFundingNets([{ positionId: id, paid: amt('5') }], PERIOD);

      await sql`DELETE FROM trade.positions WHERE id = ${id}`;
      const rows = await sql`SELECT 1 FROM trade.position_funding_applied WHERE position_id = ${id}`;
      expect(rows).toHaveLength(0);
    });
  });
  describe('funding period rate freeze', () => {
    it('keeps the first rate for a period; a second rate is ignored (race-safe insert)', async () => {
      const periods = sqlFundingPeriodStore(sql);
      expect(await periods.freezeRate(PERIOD, '0.0001')).toBe('0.0001');
      expect(await periods.freezeRate(PERIOD, '0.0003')).toBe('0.0001');
      // Concurrent first writers converge on one stored rate.
      const racing = 'BTC/USDT-PERP:2026-08-08T08:00:00.000Z';
      const got = await Promise.all(['0.0002', '0.0004', '0.0006'].map((r) => periods.freezeRate(racing, r)));
      expect(new Set(got).size).toBe(1);
      const rows = await sql`SELECT rate FROM trade.funding_period_rates WHERE period_id = ${racing}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.rate).toBe(got[0]);
    });
  });
});
