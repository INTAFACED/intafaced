/**
 * Down migrations that would delete money keys refuse while rows exist; the
 * margin adjustment sequence is unique per position.
 *
 * Needs Postgres (TEST_DATABASE_URL, else Testcontainers). Not skippable.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));
const down = (name: string) => readFileSync(join(drizzle, name), 'utf8');

const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ALICE = '11111111-1111-4111-8111-111111111111';

describe('trade down migrations keep money keys (Postgres)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];

  beforeAll(async () => {
    let url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) {
      const c = await new PostgreSqlContainer('postgres:16-alpine').start();
      url = c.getConnectionUri();
      stop = async () => {
        await c.stop();
      };
    }
    db = await createTestDatabase({ service: 'trade', url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await stop();
  }, 30_000);

  beforeEach(async () => {
    await sql`TRUNCATE trade.positions, trade.fills, trade.orders, trade.markets, trade.copy_settled_fee_shares RESTART IDENTITY CASCADE`;
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

  async function openPosition(): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO trade.positions (
        user_id, market_id, side, status, margin_mode, size, entry_price, leverage,
        margin_initial, margin_current, margin_asset, funding_paid
      ) VALUES (${ALICE}, ${MARKET}, 'long', 'open', 'isolated', '1', '50000', '5', '100', '100', 'USDT', '0')
      RETURNING id
    `;
    return row!.id;
  }

  const tableExists = async (name: string) =>
    ((await sql`SELECT to_regclass(${'trade.' + name}) AS t`)[0] as { t: string | null }).t !== null;

  it('0014 down refuses while funding periods are recorded, and keeps the table', async () => {
    const id = await openPosition();
    await sql`INSERT INTO trade.position_funding_applied (position_id, period_id, paid) VALUES (${id}, 'P1', '5')`;
    await expect(sql.unsafe(down('0014_position_funding_applied.down.sql'))).rejects.toThrow(/position_funding_applied has rows/);
    expect(await tableExists('position_funding_applied')).toBe(true);
    expect(await sql`SELECT 1 FROM trade.position_funding_applied`).toHaveLength(1);
  });

  it('0022 down refuses while fee-share claims exist, and keeps the table', async () => {
    await sql`INSERT INTO trade.copy_settled_fee_shares
      (follow_id, fill_id, leader_id, follower_id, asset_id, protocol_fee, applied_share_bps, gross_leader_share, capped_leader_share, settled)
      VALUES ('f1', 'fill1', 'l1', 'u1', 'USDT', '1', 1000, '0.1', '0.1', true)`;
    await expect(sql.unsafe(down('0022_copy_settled_fee_shares.down.sql'))).rejects.toThrow(/copy_settled_fee_shares has rows/);
    expect(await tableExists('copy_settled_fee_shares')).toBe(true);
    expect(await sql`SELECT 1 FROM trade.copy_settled_fee_shares`).toHaveLength(1);
  });

  it('0029 down refuses while margin adjustments exist, and keeps table and counter', async () => {
    const id = await openPosition();
    await sql`INSERT INTO trade.position_margin_adjustments (position_id, client_adjustment_id, request_fingerprint, sequence)
      VALUES (${id}, 'a1', 'fp', 2)`;
    await expect(sql.unsafe(down('0029_position_margin_adjust_seq.down.sql'))).rejects.toThrow(/live margin adjustments exist/);
    expect(await tableExists('position_margin_adjustments')).toBe(true);
    const cols =
      await sql`SELECT 1 FROM information_schema.columns WHERE table_schema='trade' AND table_name='positions' AND column_name='margin_adjust_seq'`;
    expect(cols).toHaveLength(1);
  });

  it('0029 down refuses when only the position counter has advanced', async () => {
    const id = await openPosition();
    await sql`UPDATE trade.positions SET margin_adjust_seq = 3 WHERE id = ${id}`;
    await expect(sql.unsafe(down('0029_position_margin_adjust_seq.down.sql'))).rejects.toThrow(/live margin adjustments exist/);
  });

  it('0075: two adjustments cannot share one (position, sequence)', async () => {
    const id = await openPosition();
    await sql`INSERT INTO trade.position_margin_adjustments (position_id, client_adjustment_id, request_fingerprint, sequence, status, result, completed_at)
      VALUES (${id}, 'a1', 'fp1', 2, 'completed', '{}'::jsonb, now())`;
    await expect(
      sql`INSERT INTO trade.position_margin_adjustments (position_id, client_adjustment_id, request_fingerprint, sequence, status, result, completed_at)
        VALUES (${id}, 'a2', 'fp2', 2, 'completed', '{}'::jsonb, now())`,
    ).rejects.toThrow(/position_margin_adjustments_position_sequence_idx|duplicate key/);
  });

  it('the downs still run when nothing is recorded', async () => {
    await sql.unsafe(down('0075_margin_adjust_sequence_unique.down.sql'));
    await sql.unsafe(down('0029_position_margin_adjust_seq.down.sql'));
    await sql.unsafe(down('0022_copy_settled_fee_shares.down.sql'));
    await sql.unsafe(down('0014_position_funding_applied.down.sql'));
    expect(await tableExists('position_funding_applied')).toBe(false);
    expect(await tableExists('copy_settled_fee_shares')).toBe(false);
  });
});
