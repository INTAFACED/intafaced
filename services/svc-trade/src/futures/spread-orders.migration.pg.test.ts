/**
 * Migration 0098 (futures spread orders): the reversal refuses while money is in flight and drops the tables once it
 * is not. Its own database, so dropping tables cannot disturb any other suite.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));
const up = readFileSync(join(drizzle, '0098_futures_spread_orders.sql'), 'utf8');
const down = readFileSync(join(drizzle, '0098_futures_spread_orders.down.sql'), 'utf8');

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_spread_migration')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('0098 futures spread orders: reversal', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql: TestDatabase['sql'];
  const FAR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const NEAR = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  beforeAll(async () => {
    const admin = await openAdmin();
    stop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
    sql = db.sql;
    for (const [id, symbol] of [
      [FAR, 'BTC/USDT-DEC'],
      [NEAR, 'BTC/USDT-NOV'],
    ] as const) {
      await sql`
        INSERT INTO trade.markets (id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional, maker_bps, taker_bps, status, display_name, listed_at)
        VALUES (${id}, ${symbol}, 'BTC', 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', ${symbol}, now())
      `;
    }
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await stop();
  }, 30_000);

  const insertOrder = async (id: string, status: string, filled = '0', engineFilled: string | null = null) => sql`
    INSERT INTO trade.futures_spread_orders (
      id, user_id, spread_id, client_order_id, side, qty, limit_price, leverage, hold_asset,
      leg0_market_id, leg0_side, leg0_ratio, leg0_mark, leg0_delta,
      leg1_market_id, leg1_side, leg1_ratio, leg1_mark, leg1_delta,
      anchor_lo, anchor_hi, filled_qty, engine_filled_qty, status
    ) VALUES (
      ${id}, 'u', 'S', ${id}, 'buy', '2', '5', '10', 'USDT',
      ${FAR}, 'buy', '1', '105', '5.25', ${NEAR}, 'sell', '1', '100', '5',
      '100', '110', ${filled}, ${engineFilled}, ${status}
    )
  `;

  it('refuses while an order may still fill or hold margin, and while a fill is unfinished', async () => {
    const live = randomUUID();
    await insertOrder(live, 'open');
    await expect(sql.unsafe(down)).rejects.toThrow(/hold money in flight/);

    await sql`UPDATE trade.futures_spread_orders SET status = 'cancelled', engine_filled_qty = '1' WHERE id = ${live}`;
    // Cancelled with a fill the engine printed that has not settled yet: still money in flight.
    await expect(sql.unsafe(down)).rejects.toThrow(/hold money in flight/);

    await sql`UPDATE trade.futures_spread_orders SET filled_qty = '1' WHERE id = ${live}`;
    await sql`
      INSERT INTO trade.futures_spread_fills (fill_key, order_id, spread_id, engine_sequence, leg_index, market_id, position_id, spread_qty, qty, price, amount, new_filled, new_adverse, new_applied, state)
      VALUES ('spread:S:1:0:p', ${live}, 'S', 1, 0, ${FAR}, ${randomUUID()}, '1', '1', '105', '10', '1', '0', '10', 'pending')
    `;
    await expect(sql.unsafe(down)).rejects.toThrow(/hold money in flight/);
    await sql`UPDATE trade.futures_spread_fills SET state = 'applied', applied_at = now()`;
    await sql`
      INSERT INTO trade.futures_spread_fill_waits (spread_id, engine_sequence, maker_order_id, taker_order_id, taker_side, price, qty,
        leg0_symbol, leg0_taker_side, leg0_qty, leg0_price, leg1_symbol, leg1_taker_side, leg1_qty, leg1_price, reason)
      VALUES ('S', 2, ${randomUUID()}, ${randomUUID()}, 'sell', '5', '1', ${FAR}, 'sell', '1', '105', ${NEAR}, 'buy', '1', '100', 'trade.liquidation_in_progress')
    `;
    await expect(sql.unsafe(down)).rejects.toThrow(/hold money in flight/);
    await sql`UPDATE trade.futures_spread_fill_waits SET settled_at = now()`;
  });

  it('drops the tables once nothing is in flight, and the forward migration applies again', async () => {
    await sql.unsafe(down);
    const gone = await sql<{ n: string }[]>`
      SELECT table_name AS n FROM information_schema.tables WHERE table_schema = 'trade' AND table_name LIKE 'futures_spread_%'
    `;
    expect(gone).toEqual([]);
    await sql.unsafe(up);
    const back = await sql<{ n: string }[]>`
      SELECT table_name AS n FROM information_schema.tables WHERE table_schema = 'trade' AND table_name LIKE 'futures_spread_%' ORDER BY 1
    `;
    expect(back.map((r) => r.n)).toEqual(['futures_spread_fill_waits', 'futures_spread_fills', 'futures_spread_orders']);
  });
});
