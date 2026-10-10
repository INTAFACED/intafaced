import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

/**
 * Up must commit each file and its indexer.__migrations insert together.
 * The scratch database is created from the admin URL below. It is never the
 * fleet database and never intafaced_test. This file does not call
 * createTestDatabase.
 */

const ADMIN_URL = 'postgres://127.0.0.1:5432/postgres';
const here = dirname(fileURLToPath(import.meta.url));
const serviceRoot = join(here, '..');
const drizzleDir = join(serviceRoot, 'drizzle');
const tsxCli = join(serviceRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const NAME_RE = /^svc_indexer_l1224_\d+_[0-9a-f]+_test$/;

function assertScratchDatabaseName(name: string): void {
  if (name === 'intafaced_test' || !name.endsWith('_test')) {
    throw new Error(`refusing database name ${name}`);
  }
  if (!NAME_RE.test(name)) {
    throw new Error(`refusing database name ${name}`);
  }
}

function scratchName(): string {
  const name = `svc_indexer_l1224_${process.pid}_${randomBytes(4).toString('hex')}_test`;
  assertScratchDatabaseName(name);
  return name;
}

function writeFixtures(files: Record<string, string>): string[] {
  const paths: string[] = [];
  for (const [name, body] of Object.entries(files)) {
    if (!/^l1224[a-c]_\d{2}_[a-z]+\.sql$/.test(name)) {
      throw new Error(`refusing fixture name ${name}`);
    }
    const path = join(drizzleDir, name);
    writeFileSync(path, body);
    paths.push(path);
  }
  return paths;
}

function removeFixtures(paths: string[]): void {
  for (const path of paths) {
    if (path.startsWith(drizzleDir) && existsSync(path)) unlinkSync(path);
  }
}

async function createScratch(): Promise<{ name: string; url: string; sql: postgres.Sql }> {
  const name = scratchName();
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const url = `postgres://127.0.0.1:5432/${name}`;
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    const [row] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
    if (row?.name !== name) {
      throw new Error(`current_database() is ${row?.name ?? 'unknown'}, expected ${name}`);
    }
    await sql`CREATE SCHEMA IF NOT EXISTS indexer`;
    await sql`
      CREATE TABLE IF NOT EXISTS indexer.__migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    return { name, url, sql };
  } catch (err) {
    await sql.end({ timeout: 5 }).catch(() => undefined);
    await dropDatabase(name);
    throw err;
  }
}

async function dropDatabase(name: string): Promise<void> {
  assertScratchDatabaseName(name);
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function dropScratch(name: string, sql: postgres.Sql): Promise<void> {
  await sql.end({ timeout: 5 }).catch(() => undefined);
  await dropDatabase(name);
}

function runUp(databaseUrl: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  assertScratchDatabaseName(name);
  if (databaseUrl.includes('svc_indexer:svc_indexer') || databaseUrl.includes(':5433/')) {
    throw new Error('refusing default DATABASE_URL');
  }
  if (name === 'intafaced' || name === 'intafaced_test') {
    throw new Error(`refusing database name ${name}`);
  }
  const env = { ...process.env };
  delete env.PGHOST;
  delete env.PGPORT;
  delete env.PGUSER;
  delete env.PGPASSWORD;
  delete env.PGDATABASE;
  env.DATABASE_URL = databaseUrl;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, join(serviceRoot, 'scripts', 'migrate.ts')], {
      cwd: serviceRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function markerExists(sql: postgres.Sql, table: string): Promise<boolean> {
  if (!/^l1224_[a-z_]+$/.test(table)) throw new Error(`refusing marker ${table}`);
  const [row] = await sql<{ reg: string | null }[]>`SELECT to_regclass(${`indexer.${table}`}) AS reg`;
  return row?.reg != null;
}

async function appliedNames(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`SELECT name FROM indexer.__migrations ORDER BY name`;
  return rows.map((row) => row.name);
}

/** Tracking insert shares the transaction that created the table. */
async function recordedInSqlTransaction(sql: postgres.Sql, table: string, file: string): Promise<boolean> {
  if (!/^l1224_[a-z_]+$/.test(table)) throw new Error(`refusing marker ${table}`);
  if (!/^l1224[a-c]_\d{2}_[a-z]+\.sql$/.test(file)) throw new Error(`refusing migration name ${file}`);
  const [row] = await sql<{ same: boolean }[]>`
    SELECT (c.xmin = m.xmin) AS same
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN indexer.__migrations m ON m.name = ${file}
    WHERE n.nspname = 'indexer' AND c.relname = ${table}
  `;
  return row?.same === true;
}

async function expectScratch(sql: postgres.Sql, name: string): Promise<void> {
  const [row] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
  expect(row?.name).toBe(name);
  expect(row?.name).not.toBe('intafaced');
  expect(row?.name).not.toBe('intafaced_test');
  expect(row?.name?.endsWith('_test')).toBe(true);
}

describe('svc-indexer migrate up', () => {
  it('refuses intafaced_test and a name that does not end in _test', () => {
    expect(() => assertScratchDatabaseName('intafaced_test')).toThrow(/refusing database name intafaced_test/);
    expect(() => assertScratchDatabaseName('intafaced')).toThrow(/refusing database name/);
    expect(() => assertScratchDatabaseName('svc_indexer_l1224_1_abcd_test')).not.toThrow();
  });

  it('skips a file that already has a tracking row', async () => {
    const db = await createScratch();
    const fixtures = writeFixtures({
      'l1224a_10_kept.sql': 'CREATE TABLE indexer.l1224_reran (id integer);\n',
      'l1224b_20_next.sql': 'CREATE TABLE indexer.l1224_next (id integer);\n',
    });
    try {
      await expectScratch(db.sql, db.name);
      await db.sql.unsafe('CREATE TABLE indexer.l1224_kept (id integer)');
      await db.sql`INSERT INTO indexer.__migrations (name) VALUES (${'l1224a_10_kept.sql'})`;

      const result = await runUp(db.url);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('· l1224a_10_kept.sql (already applied)');
      expect(result.stdout).not.toContain('↑ l1224a_10_kept.sql');
      expect(result.stdout).toContain('↑ l1224b_20_next.sql');
      expect(await markerExists(db.sql, 'l1224_kept')).toBe(true);
      expect(await markerExists(db.sql, 'l1224_reran')).toBe(false);
      expect(await markerExists(db.sql, 'l1224_next')).toBe(true);
      const names = await appliedNames(db.sql);
      expect(names).toContain('l1224a_10_kept.sql');
      expect(names).toContain('l1224b_20_next.sql');
    } finally {
      removeFixtures(fixtures);
      await dropScratch(db.name, db.sql);
    }
  }, 60_000);

  it('rolls back a mid-file statement error and records a successful file only in that commit', async () => {
    const db = await createScratch();
    const fixtures = writeFixtures({
      'l1224a_10_ok.sql': 'CREATE TABLE indexer.l1224_ok (id integer);\n',
      'l1224b_20_mid.sql':
        'CREATE TABLE indexer.l1224_partial (id integer);\n' +
        "DO $$ BEGIN RAISE EXCEPTION 'l1224 up failed'; END $$;\n" +
        'CREATE TABLE indexer.l1224_later (id integer);\n',
      'l1224c_30_after.sql': 'CREATE TABLE indexer.l1224_after (id integer);\n',
    });
    try {
      await expectScratch(db.sql, db.name);

      const result = await runUp(db.url);

      expect(result.code).not.toBe(0);
      expect(`${result.stderr}\n${result.stdout}`).toMatch(/l1224 up failed/);
      expect(result.stdout).toContain('↑ l1224a_10_ok.sql');
      expect(result.stdout).toContain('↑ l1224b_20_mid.sql');
      expect(result.stdout).not.toContain('l1224c_30_after');
      expect(await markerExists(db.sql, 'l1224_ok')).toBe(true);
      expect(await markerExists(db.sql, 'l1224_partial')).toBe(false);
      expect(await markerExists(db.sql, 'l1224_later')).toBe(false);
      expect(await markerExists(db.sql, 'l1224_after')).toBe(false);
      const names = await appliedNames(db.sql);
      expect(names).toContain('0000_indexer_init.sql');
      expect(names).toContain('l1224a_10_ok.sql');
      expect(names).not.toContain('l1224b_20_mid.sql');
      expect(names).not.toContain('l1224c_30_after.sql');
      expect(await recordedInSqlTransaction(db.sql, 'l1224_ok', 'l1224a_10_ok.sql')).toBe(true);
    } finally {
      removeFixtures(fixtures);
      await dropScratch(db.name, db.sql);
    }
  }, 60_000);
});
