import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { postgresAvailable } from '@intafaced/db';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The runner must commit a migration file and its notify.__migrations row
 * together. These cases use a private database: a bookkeeping trigger that
 * aborts the ledger write, a second --down, and two runners released from the
 * same lock. None of them connect to intafaced_test.
 */

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = join(PKG, 'node_modules', '.bin', 'tsx');
const UPS = readdirSync(join(PKG, 'drizzle'))
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort();

const localAdminDb = 'postgres';
const ADMIN_CANDIDATES = [
  process.env.TEST_DATABASE_URL,
  `postgres://127.0.0.1:5432/${localAdminDb}`,
  'postgres://intafaced_ops:intafaced_ops@127.0.0.1:5433/intafaced_test',
].filter((value): value is string => typeof value === 'string' && value.length > 0);

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

interface Isolated {
  name: string;
  url: string;
  sql: postgres.Sql;
  drop: () => Promise<void>;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function databaseName(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

function assertIsolated(url: string): void {
  const name = databaseName(url);
  if (!/^[a-z][a-z0-9_]*_test$/.test(name) || name === 'intafaced_test') {
    throw new Error(`refusing to migrate ${name}`);
  }
}

async function openAdmin(): Promise<{ sql: postgres.Sql; url: string } | null> {
  for (const url of ADMIN_CANDIDATES) {
    // The shared, CI-aware probe: it throws under CI / REQUIRE_POSTGRES when this
    // candidate is down, and journals the decision either way, so a laptop skip is
    // visible to `pnpm verify` instead of silent. It replaces a private
    // `postgres(url, { connect_timeout })` probe that swallowed every error.
    if (!(await postgresAvailable(url))) continue;
    const sql = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      const rows = await sql<{ ok: boolean }[]>`
        SELECT (rolcreatedb OR rolsuper) AS ok
        FROM pg_roles
        WHERE rolname = current_user
      `;
      if (rows[0]?.ok) return { sql, url };
    } catch {
      // Reachable, but the role check was refused. Try the next candidate.
    }
    await sql.end({ timeout: 1 }).catch(() => undefined);
  }
  return null;
}

const admin = await openAdmin();
if (!admin && (process.env.CI === 'true' || process.env.CI === '1' || process.env.REQUIRE_POSTGRES === '1')) {
  throw new Error('Postgres is required for the notify migration transaction check');
}

function freshName(): string {
  const name = `l1162_notify_${process.pid}_${Math.random().toString(36).slice(2, 8)}_test`;
  if (!/^[a-z][a-z0-9_]*_test$/.test(name)) throw new Error(`unsafe database name ${name}`);
  return name;
}

async function provision(): Promise<Isolated> {
  if (!admin) throw new Error('postgres is down');
  const name = freshName();
  await admin.sql.unsafe(`CREATE DATABASE "${name}"`);
  const url = withDatabase(admin.url, name);
  assertIsolated(url);
  const sql = postgres(url, { max: 4, onnotice: () => undefined });
  try {
    const rows = await sql<{ db: string }[]>`SELECT current_database() AS db`;
    if (rows[0]?.db !== name) throw new Error(`connected to ${rows[0]?.db}, wanted ${name}`);
    await sql.unsafe('CREATE SCHEMA IF NOT EXISTS notify');
  } catch (err) {
    await sql.end({ timeout: 1 }).catch(() => undefined);
    await admin.sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
    throw err;
  }
  return {
    name,
    url,
    sql,
    drop: async () => {
      await sql.end({ timeout: 1 }).catch(() => undefined);
      await admin.sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    },
  };
}

function runMigrate(url: string, args: string[] = []): Promise<Run> {
  assertIsolated(url);
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, ['scripts/migrate.ts', ...args], {
      cwd: PKG,
      env: { ...process.env, DATABASE_URL: url },
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
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function text(result: Run): string {
  return `${result.stdout}\n${result.stderr}`.trim();
}

async function whaleCheck(sql: postgres.Sql): Promise<string> {
  const rows = await sql<{ def: string }[]>`
    SELECT pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'notify' AND c.conname = 'price_alerts_kind_ck'
  `;
  return rows[0]?.def ?? '';
}

async function installBookkeepingTripwire(sql: postgres.Sql, event: 'INSERT' | 'DELETE'): Promise<void> {
  await sql.unsafe(`
    CREATE OR REPLACE FUNCTION notify.reject_migration_bookkeeping()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      RAISE EXCEPTION 'bookkeeping refused';
    END
    $fn$
  `);
  await sql.unsafe(`
    CREATE TRIGGER reject_migration_bookkeeping
    BEFORE ${event} ON notify.__migrations
    FOR EACH ROW
    EXECUTE FUNCTION notify.reject_migration_bookkeeping()
  `);
}

async function waitForLockWaits(sql: postgres.Sql, want: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
    `;
    if ((rows[0]?.n ?? 0) >= want) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${want} lock waits, saw ${rows[0]?.n ?? 0}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(!admin)('notify migration file and ledger row are one transaction', () => {
  afterAll(async () => {
    await admin?.sql.end({ timeout: 1 }).catch(() => undefined);
  });

  it('rolls the file back when the ledger insert fails', async () => {
    const db = await provision();
    try {
      await db.sql.unsafe(`
        CREATE TABLE notify.__migrations (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await installBookkeepingTripwire(db.sql, 'INSERT');
      const result = await runMigrate(db.url);
      expect(result.code, text(result)).not.toBe(0);
      expect(text(result)).toContain('bookkeeping refused');
      const tables = await db.sql<{ reg: string | null }[]>`
        SELECT to_regclass('notify.notifications')::text AS reg
      `;
      expect(tables[0]?.reg ?? null).toBeNull();
      const rows = await db.sql`SELECT name FROM notify.__migrations`;
      expect(rows.length).toBe(0);
    } finally {
      await db.drop();
    }
  }, 60_000);

  it('rolls a down file back when the ledger delete fails', async () => {
    const db = await provision();
    try {
      const up = await runMigrate(db.url);
      expect(up.code, text(up)).toBe(0);
      expect(await whaleCheck(db.sql)).toContain('whale');
      await installBookkeepingTripwire(db.sql, 'DELETE');
      const down = await runMigrate(db.url, ['--down']);
      expect(down.code, text(down)).not.toBe(0);
      expect(text(down)).toContain('bookkeeping refused');
      expect(await whaleCheck(db.sql)).toContain('whale');
      const row = await db.sql`
        SELECT name FROM notify.__migrations WHERE name = '0008_notify_whale_kind.sql'
      `;
      expect(row.length).toBe(1);
    } finally {
      await db.drop();
    }
  }, 60_000);

  it('treats a second down as a no-op', async () => {
    const db = await provision();
    try {
      const up = await runMigrate(db.url);
      expect(up.code, text(up)).toBe(0);
      const down = await runMigrate(db.url, ['--down']);
      expect(down.code, text(down)).toBe(0);
      const again = await runMigrate(db.url, ['--down']);
      expect(again.code, text(again)).toBe(0);
      expect(again.stdout).toContain('already reversed');
      expect(again.stdout).not.toContain('↓');
    } finally {
      await db.drop();
    }
  }, 60_000);

  it('does not let two overlapping runners both apply a file', async () => {
    const db = await provision();
    const gate = postgres(db.url, { max: 1, onnotice: () => undefined });
    try {
      await db.sql.unsafe(`
        CREATE TABLE notify.__migrations (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await gate.unsafe('BEGIN');
      await gate.unsafe('LOCK TABLE notify.__migrations IN ACCESS EXCLUSIVE MODE');
      const pending = Promise.all([runMigrate(db.url), runMigrate(db.url)]);
      await waitForLockWaits(db.sql, 2);
      await gate.unsafe('COMMIT');
      const [first, second] = await pending;
      expect(first.code, text(first)).toBe(0);
      expect(second.code, text(second)).toBe(0);
      const rows = await db.sql<{ name: string }[]>`
        SELECT name FROM notify.__migrations ORDER BY name
      `;
      expect(rows.map((row) => row.name)).toEqual(UPS);
      const again = await runMigrate(db.url);
      expect(again.code, text(again)).toBe(0);
      expect(again.stdout).toContain('already applied');
      const count = await db.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM notify.__migrations
      `;
      expect(count[0]?.n).toBe(UPS.length);
    } finally {
      await gate.unsafe('ROLLBACK').catch(() => undefined);
      await gate.end({ timeout: 1 }).catch(() => undefined);
      await db.drop();
    }
  }, 90_000);
});
