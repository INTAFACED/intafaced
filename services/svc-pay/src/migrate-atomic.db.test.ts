/**
 * A migration file and its pay.__migrations row commit in one transaction.
 *
 * TEST_DATABASE_URL is only the admin connection. current_database() there must
 * end in _test, and a database named postgres is refused. The file runs on a
 * new database whose name ends in _test and is not intafaced_test. Schema pay
 * is created on that database, never on the admin database. This file does not
 * apply drizzle/ and does not use a JavaScript number for money.
 */
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrationFile } from '../scripts/migrate.js';

const PROBE = 'pay.probe';
const PROBE_NAME = 'probe.sql';
const PROBE_UP = 'CREATE TABLE pay.probe (id int)';
const PROBE_DOWN = 'DROP TABLE pay.probe';
const UP_DIV_ZERO = 'SELECT 1/0';
const DOWN_DIV_ZERO = 'DROP TABLE pay.probe; SELECT 1/0';

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error('TEST_DATABASE_URL is unset; refusing to guess a database for migration tracking');
  }
  return url;
}

function assertTestDatabase(name: string, what: string): void {
  if (name === 'postgres') {
    throw new Error(`refusing ${what} on database postgres`);
  }
  if (!name.endsWith('_test')) {
    throw new Error(`refusing ${what} on database ${name}`);
  }
}

describe('a migration file and its tracking row commit together', () => {
  let admin: postgres.Sql | undefined;
  let sql: postgres.Sql | undefined;
  let database = '';

  beforeAll(async () => {
    const adminUrl = testDatabaseUrl();
    admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
    const current = await admin<Array<{ db: string }>>`SELECT current_database() AS db`;
    const adminDatabase = current[0]?.db ?? '';
    assertTestDatabase(adminDatabase, 'an admin connection');

    database = `itf_run_pay_l883_${process.pid}_test`;
    if (!/^[a-z][a-z0-9_]*_test$/.test(database) || database === 'intafaced_test' || database === adminDatabase) {
      throw new Error(`refusing to migrate on database ${database}`);
    }
    assertTestDatabase(database, 'a migration run');

    await admin.unsafe(`CREATE DATABASE "${database}"`);

    const url = new URL(adminUrl);
    url.pathname = `/${database}`;
    sql = postgres(url.toString(), { max: 1, onnotice: () => undefined });

    const opened = await sql<Array<{ db: string }>>`SELECT current_database() AS db`;
    const openedName = opened[0]?.db ?? '';
    if (openedName === 'intafaced_test' || openedName === adminDatabase) {
      throw new Error(`refusing to migrate on database ${openedName}`);
    }
    assertTestDatabase(openedName, 'a migration run');

    await sql`CREATE SCHEMA pay`;
    await sql`
      CREATE TABLE pay.__migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;
  }, 30_000);

  beforeEach(async () => {
    const db = sql;
    if (!db) throw new Error('migration database was not opened');
    await db`DROP TABLE IF EXISTS pay.probe`;
    await db`DELETE FROM pay.__migrations`;
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 }).catch(() => undefined);
    sql = undefined;
    if (
      admin &&
      database.endsWith('_test') &&
      database !== 'intafaced_test' &&
      database !== 'postgres' &&
      /^[a-z][a-z0-9_]*_test$/.test(database)
    ) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    }
    if (admin) {
      const left = await admin<Array<{ db: string; pay: string | null }>>`
        SELECT current_database() AS db,
               (SELECT nspname FROM pg_namespace WHERE nspname = 'pay') AS pay
      `;
      const row = left[0];
      if (!row || row.db === 'postgres' || !row.db.endsWith('_test')) {
        await admin.end({ timeout: 5 }).catch(() => undefined);
        throw new Error(`admin connection is database ${row?.db ?? ''}`);
      }
      if (row.pay === 'pay') {
        await admin.end({ timeout: 5 }).catch(() => undefined);
        throw new Error('schema pay was written on the admin database');
      }
    }
    await admin?.end({ timeout: 5 }).catch(() => undefined);
  }, 30_000);

  function db(): postgres.Sql {
    if (!sql) throw new Error('migration database was not opened');
    return sql;
  }

  async function probeExists(): Promise<boolean> {
    const database = db();
    const rows = await database<Array<{ present: boolean }>>`
      SELECT to_regclass(${PROBE}) IS NOT NULL AS present
    `;
    return rows[0]?.present === true;
  }

  async function tracked(): Promise<string[]> {
    const database = db();
    const rows = await database<Array<{ name: string }>>`SELECT name FROM pay.__migrations ORDER BY name`;
    return rows.map((row) => row.name);
  }

  async function payTables(): Promise<string[]> {
    const database = db();
    const rows = await database<Array<{ relname: string }>>`
      SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'pay'
         AND c.relkind = 'r'
       ORDER BY c.relname
    `;
    return rows.map((row) => row.relname);
  }

  it('commits a create and its tracking row', async () => {
    await applyMigrationFile(db(), 'up', PROBE_NAME, PROBE_UP);
    expect(await probeExists()).toBe(true);
    expect(await tracked()).toEqual([PROBE_NAME]);
  });

  it('rolls back an up that throws, writes no tracking row, and creates no table', async () => {
    await expect(applyMigrationFile(db(), 'up', 'divzero.sql', UP_DIV_ZERO)).rejects.toThrow();
    expect(await tracked()).toEqual([]);
    expect(await probeExists()).toBe(false);
    expect(await payTables()).toEqual(['__migrations']);
  });

  it('rolls back a down that throws and keeps the probe table and the tracking row', async () => {
    const database = db();
    await database`CREATE TABLE pay.probe (id int)`;
    await database`INSERT INTO pay.__migrations (name) VALUES (${PROBE_NAME})`;
    await expect(applyMigrationFile(database, 'down', PROBE_NAME, DOWN_DIV_ZERO)).rejects.toThrow();
    expect(await probeExists()).toBe(true);
    expect(await tracked()).toEqual([PROBE_NAME]);
  });

  it('commits a drop and deletes the tracking row', async () => {
    const database = db();
    await database`CREATE TABLE pay.probe (id int)`;
    await database`INSERT INTO pay.__migrations (name) VALUES (${PROBE_NAME})`;
    await applyMigrationFile(database, 'down', PROBE_NAME, PROBE_DOWN);
    expect(await probeExists()).toBe(false);
    expect(await tracked()).toEqual([]);
  });
});
