/**
 * The mining_pool migration runner against a real Postgres. Applies each
 * migration once, a re-run changes nothing, and `--down` reverses what was
 * applied. Each run gets its own `_test` database, dropped afterwards.
 *
 * Amounts are not involved; the tables stay empty.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { runMigrations } from './migrate-transaction.js';

const adminUrl = process.env.TEST_DATABASE_URL;
if (adminUrl === undefined || adminUrl.trim() === '') {
  throw new Error('TEST_DATABASE_URL is unset');
}

const migrationsDir = fileURLToPath(new URL('../drizzle', import.meta.url));
const script = fileURLToPath(new URL('../scripts/migrate.ts', import.meta.url));
const UPS = ['0000_mining_pool_init.sql', '0001_blank_reward_share.sql'];

describe('mining_pool migrate runner', () => {
  let db: TestDatabase | undefined;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'mining_pool', url: adminUrl, migrations: [] });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 60_000);

  function target(): TestDatabase {
    if (db === undefined) throw new Error('test database was not created');
    return db;
  }

  const applied = async () =>
    (await target().sql<Array<{ name: string }>>`SELECT name FROM mining_pool.__migrations ORDER BY name`).map((r) => r.name);

  it('applies every migration once, and a re-run is a no-op', async () => {
    const { sql } = target();
    expect(await runMigrations(sql, migrationsDir)).toEqual(UPS);
    expect(await applied()).toEqual(UPS);
    const tables = await sql<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'mining_pool' AND table_name IN ('windows', 'shares') ORDER BY table_name`;
    expect(tables.map((t) => t.table_name)).toEqual(['shares', 'windows']);

    expect(await runMigrations(sql, migrationsDir)).toEqual([]);
    expect(await applied()).toEqual(UPS);
  });

  it('db:migrate (the real script) is also a no-op on an up-to-date database', async () => {
    const run = spawnSync('pnpm', ['exec', 'tsx', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, DATABASE_URL: target().url },
      encoding: 'utf8',
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('(already applied)');
    expect(run.stdout).not.toContain('↑');
    expect(await applied()).toEqual(UPS);
  }, 60_000);

  it('reverses applied migrations, latest first', async () => {
    const { sql } = target();
    expect(await runMigrations(sql, migrationsDir, { down: true })).toEqual([...UPS].reverse());
    expect(await applied()).toEqual([]);
  });
});
