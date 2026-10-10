import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

/**
 * --down must read indexer.__migrations and undo that set in one transaction.
 * The scratch database is created from the admin URL below. It is never the
 * fleet database and never intafaced_test.
 */

const ADMIN_URL = 'postgres://127.0.0.1:5432/postgres';
const here = dirname(fileURLToPath(import.meta.url));
const serviceRoot = join(here, '..');
const drizzleDir = join(serviceRoot, 'drizzle');
const tsxCli = join(serviceRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const NAME_RE = /^svc_indexer_l1223_\d+_[0-9a-f]+_test$/;

function assertScratchDatabaseName(name: string): void {
  if (name === 'intafaced_test' || !name.endsWith('_test')) {
    throw new Error(`refusing database name ${name}`);
  }
  if (!NAME_RE.test(name)) {
    throw new Error(`refusing database name ${name}`);
  }
}

function scratchName(): string {
  const name = `svc_indexer_l1223_${process.pid}_${randomBytes(4).toString('hex')}_test`;
  assertScratchDatabaseName(name);
  return name;
}

function writeFixtures(files: Record<string, string>): string[] {
  const paths: string[] = [];
  for (const [name, body] of Object.entries(files)) {
    if (!/^l1223[a-c]_\d{2}_[a-z]+(\.down)?\.sql$/.test(name)) {
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

function runDown(databaseUrl: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  assertScratchDatabaseName(name);
  if (databaseUrl.includes('svc_indexer:svc_indexer') || databaseUrl.includes(':5433/')) {
    throw new Error('refusing default DATABASE_URL');
  }
  const env = { ...process.env };
  delete env.PGHOST;
  delete env.PGPORT;
  delete env.PGUSER;
  delete env.PGPASSWORD;
  delete env.PGDATABASE;
  env.DATABASE_URL = databaseUrl;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, join(serviceRoot, 'scripts', 'migrate.ts'), '--down'], {
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
  if (!/^l1223_[a-z]+$/.test(table)) throw new Error(`refusing marker ${table}`);
  const [row] = await sql<{ reg: string | null }[]>`SELECT to_regclass(${`indexer.${table}`}) AS reg`;
  return row?.reg != null;
}

async function appliedNames(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`SELECT name FROM indexer.__migrations ORDER BY name`;
  return rows.map((row) => row.name);
}

async function expectScratch(sql: postgres.Sql, name: string): Promise<void> {
  const [row] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
  expect(row?.name).toBe(name);
  expect(row?.name).not.toBe('intafaced');
  expect(row?.name).not.toBe('intafaced_test');
  expect(row?.name?.endsWith('_test')).toBe(true);
}

describe('svc-indexer migrate --down', () => {
  it('refuses intafaced_test and a name that does not end in _test', () => {
    expect(() => assertScratchDatabaseName('intafaced_test')).toThrow(/refusing database name intafaced_test/);
    expect(() => assertScratchDatabaseName('intafaced')).toThrow(/refusing database name/);
    expect(() => assertScratchDatabaseName('svc_indexer_l1223_1_abcd_test')).not.toThrow();
  });

  it('does not reverse an unapplied file, and reverses an applied file', async () => {
    const db = await createScratch();
    const fixtures = writeFixtures({
      'l1223a_10_applied.sql': '-- applied\n',
      'l1223a_10_applied.down.sql': 'DROP TABLE IF EXISTS indexer.l1223_applied;\n',
      'l1223a_20_unapplied.sql': '-- unapplied\n',
      'l1223a_20_unapplied.down.sql': 'DROP TABLE IF EXISTS indexer.l1223_unapplied;\n',
    });
    try {
      await expectScratch(db.sql, db.name);
      await db.sql.unsafe('CREATE TABLE indexer.l1223_applied (id integer)');
      await db.sql.unsafe('CREATE TABLE indexer.l1223_unapplied (id integer)');
      await db.sql`INSERT INTO indexer.__migrations (name) VALUES (${'l1223a_10_applied.sql'})`;

      const result = await runDown(db.url);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('↓ l1223a_10_applied.down.sql');
      expect(result.stdout).not.toContain('l1223a_20_unapplied');
      expect(await markerExists(db.sql, 'l1223_applied')).toBe(false);
      expect(await markerExists(db.sql, 'l1223_unapplied')).toBe(true);
      expect(await appliedNames(db.sql)).not.toContain('l1223a_10_applied.sql');
    } finally {
      removeFixtures(fixtures);
      await dropScratch(db.name, db.sql);
    }
  }, 60_000);

  it('rolls back the newer applied reversal when a reversal throws', async () => {
    const db = await createScratch();
    const fixtures = writeFixtures({
      'l1223b_10_throws.sql': '-- throws\n',
      'l1223b_10_throws.down.sql': "DO $$ BEGIN RAISE EXCEPTION 'l1223 reversal failed'; END $$;\n",
      'l1223b_20_newer.sql': '-- newer\n',
      'l1223b_20_newer.down.sql': 'DROP TABLE IF EXISTS indexer.l1223_newer;\n',
      'l1223b_30_unapplied.sql': '-- unapplied\n',
      'l1223b_30_unapplied.down.sql': 'DROP TABLE IF EXISTS indexer.l1223_unapplied;\n',
    });
    try {
      await expectScratch(db.sql, db.name);
      await db.sql.unsafe('CREATE TABLE indexer.l1223_newer (id integer)');
      await db.sql.unsafe('CREATE TABLE indexer.l1223_unapplied (id integer)');
      await db.sql`
        INSERT INTO indexer.__migrations (name) VALUES
          (${'l1223b_10_throws.sql'}),
          (${'l1223b_20_newer.sql'})
      `;

      const result = await runDown(db.url);

      expect(result.code).not.toBe(0);
      expect(`${result.stderr}\n${result.stdout}`).toMatch(/l1223 reversal failed/);
      expect(await markerExists(db.sql, 'l1223_newer')).toBe(true);
      expect(await markerExists(db.sql, 'l1223_unapplied')).toBe(true);
      const names = await appliedNames(db.sql);
      expect(names).toContain('l1223b_20_newer.sql');
      expect(names).toContain('l1223b_10_throws.sql');
      expect(names).not.toContain('l1223b_30_unapplied.sql');
    } finally {
      removeFixtures(fixtures);
      await dropScratch(db.name, db.sql);
    }
  }, 60_000);

  it('throws when an applied reversal file is missing and keeps the newer reversal uncommitted', async () => {
    const db = await createScratch();
    const fixtures = writeFixtures({
      'l1223c_10_missing.sql': '-- applied, no reversal file\n',
      'l1223c_20_newer.sql': '-- newer\n',
      'l1223c_20_newer.down.sql': 'DROP TABLE IF EXISTS indexer.l1223_newer;\n',
    });
    try {
      await expectScratch(db.sql, db.name);
      await db.sql.unsafe('CREATE TABLE indexer.l1223_newer (id integer)');
      await db.sql`
        INSERT INTO indexer.__migrations (name) VALUES
          (${'l1223c_10_missing.sql'}),
          (${'l1223c_20_newer.sql'})
      `;

      const result = await runDown(db.url);

      expect(result.code).not.toBe(0);
      expect(`${result.stderr}\n${result.stdout}`).toMatch(/l1223c_10_missing\.down\.sql/);
      expect(await markerExists(db.sql, 'l1223_newer')).toBe(true);
      const names = await appliedNames(db.sql);
      expect(names).toContain('l1223c_20_newer.sql');
      expect(names).toContain('l1223c_10_missing.sql');
    } finally {
      removeFixtures(fixtures);
      await dropScratch(db.name, db.sql);
    }
  }, 60_000);
});
