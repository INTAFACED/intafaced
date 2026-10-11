/**
 * L1130. A migration body and its bank.__migrations write commit together.
 * When the insert fails, the body rolls back. Down reverses only names that
 * are already in the book, latest filename first.
 *
 * Amounts are not involved.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { applyMigrationDown, applyMigrationUp, reversalNames } from './migrate-transaction.js';

const adminUrl = process.env.TEST_DATABASE_URL;
if (adminUrl === undefined || adminUrl.trim() === '') {
  throw new Error('TEST_DATABASE_URL is unset');
}

const adminDatabase = decodeURIComponent(new URL(adminUrl).pathname.replace(/^\//, ''));
if (adminDatabase === '' || adminDatabase === 'postgres') {
  throw new Error('refusing to connect to a database named postgres');
}

const PROBE_NAME = 'probe.sql';
const PROBE_BODY = 'CREATE TABLE "bank"."l1130_probe" ("id" int)';
const FRESH_NAME = 'l1130_fresh.sql';
const FRESH_BODY = 'CREATE TABLE "bank"."l1130_fresh" ("id" int)';

describe('reversalNames', () => {
  it('returns only applied names, latest filename first', () => {
    const names = reversalNames(['a.sql', 'b.sql', 'c.sql'], new Set(['a.sql', 'c.sql']));
    expect(names).toEqual(['c.sql', 'a.sql']);
    expect(names).not.toContain('b.sql');
  });
});

describe('migration bookkeeping transaction', () => {
  let db: TestDatabase | undefined;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'bank', url: adminUrl, migrations: [] });
    await db.sql`
      CREATE TABLE IF NOT EXISTS bank.__migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 60_000);

  function bank(): TestDatabase {
    if (db === undefined) throw new Error('test database was not created');
    return db;
  }

  it('uses a per-run bank database, not the admin database', async () => {
    const target = bank();
    const rows = await target.sql<Array<{ name: string }>>`SELECT current_database() AS name`;
    const current = rows[0]?.name;
    expect(target.database).toMatch(/^itf_run_bank_.*_test$/);
    expect(current).toBe(target.database);
    expect(current).not.toBe('intafaced_test');
    console.log(target.database);
  });

  it('rolls the up body back when the bookkeeping insert fails', async () => {
    const target = bank();
    await target.sql`INSERT INTO bank.__migrations (name) VALUES (${PROBE_NAME})`;
    await expect(applyMigrationUp(target.sql, PROBE_NAME, PROBE_BODY)).rejects.toThrow();
    const tables = await target.sql<Array<{ reg: string | null }>>`
      SELECT to_regclass('bank.l1130_probe')::text AS reg
    `;
    expect(tables[0]?.reg).toBeNull();
  });

  it('commits the up body and the bookkeeping row together', async () => {
    const target = bank();
    await applyMigrationUp(target.sql, FRESH_NAME, FRESH_BODY);
    const tables = await target.sql<Array<{ schema: string; name: string }>>`
      SELECT table_schema AS schema, table_name AS name
      FROM information_schema.tables
      WHERE table_schema = 'bank' AND table_name = 'l1130_fresh'
    `;
    expect(tables).toEqual([{ schema: 'bank', name: 'l1130_fresh' }]);
    const rows = await target.sql<Array<{ name: string }>>`
      SELECT name FROM bank.__migrations WHERE name = ${FRESH_NAME}
    `;
    expect(rows.map((row) => row.name)).toEqual([FRESH_NAME]);
  });

  it('commits a down body and the bookkeeping delete together', async () => {
    const target = bank();
    const name = 'l1130_down.sql';
    await applyMigrationUp(target.sql, name, 'CREATE TABLE "bank"."l1130_down" ("id" int)');
    await applyMigrationDown(target.sql, name, 'DROP TABLE "bank"."l1130_down"');
    const tables = await target.sql<Array<{ reg: string | null }>>`
      SELECT to_regclass('bank.l1130_down')::text AS reg
    `;
    expect(tables[0]?.reg).toBeNull();
    const rows = await target.sql<Array<{ name: string }>>`
      SELECT name FROM bank.__migrations WHERE name = ${name}
    `;
    expect(rows).toEqual([]);
  });
});
