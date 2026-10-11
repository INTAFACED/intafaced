import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * L1250. `yield_windows.total_amount` must be a finite value greater than 0.
 *
 * 0004 checks `total_amount > 0`. `numeric(38, 18)` stores NaN, and PostgreSQL
 * orders NaN above every finite value, so that check accepts it. A NaN total
 * then claims `window_id` without being a positive revenue amount.
 *
 * The figure below is the existing yield fixture, not a new revenue amount.
 * Zero and its negation are the rejected probes. No default is added.
 * The admin URL is `postgres`, and the migrated database is a per-run name
 * other than `intafaced_test`.
 */

const ADMIN_URL = 'postgres://127.0.0.1:5432/postgres';
const YIELD_AMOUNT = '100';
const NAN_WINDOW = 'l1250-nan';
const FINITE_WINDOW = 'l1250-finite';
const ZERO_WINDOW = 'l1250-zero';
const NEGATIVE_WINDOW = 'l1250-negative';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzleDir, file), 'utf8'));

function runDatabaseName(): string {
  const name = `itf_l1250_${process.pid}_${Math.random().toString(36).slice(2, 8)}_test`;
  if (name === 'intafaced_test' || !/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`refusing database name ${name}`);
  }
  return name;
}

describe('L1250 yield window total', () => {
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let database = '';

  beforeAll(async () => {
    database = runDatabaseName();
    admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
    const adminDb = await admin<Array<{ db: string }>>`SELECT current_database() AS db`;
    if (adminDb[0]?.db === 'intafaced_test') throw new Error('refusing to migrate intafaced_test');
    await admin.unsafe(`CREATE DATABASE "${database}"`);

    const url = new URL(ADMIN_URL);
    url.pathname = `/${database}`;
    sql = postgres(url.toString(), { max: 4, onnotice: () => undefined });
    const live = await sql<Array<{ db: string }>>`SELECT current_database() AS db`;
    if (live[0]?.db !== database || live[0]?.db === 'intafaced_test') {
      throw new Error(`refusing to migrate ${live[0]?.db ?? '<unknown>'}`);
    }
    await sql.unsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await sql.unsafe('CREATE SCHEMA IF NOT EXISTS token');
    for (const migration of migrations) {
      await sql.unsafe(migration);
    }
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 0 }).catch(() => undefined);
    if (admin && database && database !== 'intafaced_test') {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
    }
  }, 30_000);

  async function insertTotal(windowId: string, amount: string): Promise<void> {
    await sql`
      INSERT INTO token.yield_windows (window_id, total_amount)
      VALUES (${windowId}, ${amount}::numeric)
    `;
  }

  async function storedTotal(windowId: string): Promise<string | undefined> {
    const rows = await sql<Array<{ total_amount: string }>>`
      SELECT total_amount::text AS total_amount
        FROM token.yield_windows
       WHERE window_id = ${windowId}
    `;
    return rows[0]?.total_amount;
  }

  it('migrates a per-run database that is not intafaced_test', () => {
    expect(database).not.toBe('intafaced_test');
    expect(database.startsWith('itf_l1250_')).toBe(true);
  });

  it('does not default total_amount', async () => {
    const cols = await sql<Array<{ column_default: string | null }>>`
      SELECT column_default
        FROM information_schema.columns
       WHERE table_schema = 'token'
         AND table_name = 'yield_windows'
         AND column_name = 'total_amount'
    `;
    expect(cols).toHaveLength(1);
    expect(cols[0]?.column_default).toBeNull();
  });

  it('rejects a NaN total so it cannot claim window_id', async () => {
    let stored: string | undefined;
    try {
      await insertTotal(NAN_WINDOW, 'NaN');
      stored = await storedTotal(NAN_WINDOW);
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
      expect(code).toBe('23514');
    }
    expect(stored, 'NaN total must not claim window_id').toBeUndefined();
  });

  it('inserts a positive finite total', async () => {
    await insertTotal(FINITE_WINDOW, YIELD_AMOUNT);
    const stored = await storedTotal(FINITE_WINDOW);
    const expected = await sql<Array<{ total_amount: string }>>`
      SELECT ${YIELD_AMOUNT}::numeric(38, 18)::text AS total_amount
    `;
    expect(stored).toBe(expected[0]?.total_amount);
    const finite = await sql<Array<{ ok: boolean }>>`
      SELECT (total_amount > 0 AND total_amount <> 'NaN'::numeric) AS ok
        FROM token.yield_windows
       WHERE window_id = ${FINITE_WINDOW}
    `;
    expect(finite[0]?.ok).toBe(true);
  });

  it('rejects zero and negative totals', async () => {
    await expect(insertTotal(ZERO_WINDOW, '0')).rejects.toMatchObject({ code: '23514' });
    await expect(insertTotal(NEGATIVE_WINDOW, `-${YIELD_AMOUNT}`)).rejects.toMatchObject({ code: '23514' });
    expect(await storedTotal(ZERO_WINDOW)).toBeUndefined();
    expect(await storedTotal(NEGATIVE_WINDOW)).toBeUndefined();
  });
});
