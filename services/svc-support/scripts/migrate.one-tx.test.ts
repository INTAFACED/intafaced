import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { postgresAvailable } from '@intafaced/db';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The runner must commit a migration file and its support.__migrations row
 * together. These cases use a private database: a bookkeeping trigger that
 * aborts the ledger write, a second --down, and two runners released from the
 * same lock. None of them connect to intafaced_test.
 */

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = join(PKG, 'node_modules', '.bin', 'tsx');
const UPS = readdirSync(join(PKG, 'drizzle'))
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort();

const ADMIN_CANDIDATES = [process.env.TEST_DATABASE_URL_SUPPORT_ADMIN ?? 'postgres://127.0.0.1:5432/postgres'];

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
  throw new Error('Postgres is required for the support migration transaction check');
}

function freshName(): string {
  const name = `support_runner_${process.pid}_${Math.random().toString(36).slice(2, 8)}_test`;
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
    await sql.unsafe('CREATE SCHEMA IF NOT EXISTS support');
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

async function versionGuard(sql: postgres.Sql): Promise<string> {
  const rows = await sql<{ def: string }[]>`
    SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger
    WHERE tgname = 'kb_articles_version_locked_trg'
  `;
  return rows[0]?.def ?? '';
}

async function publicBase(db: Isolated): Promise<string> {
  await db.sql.unsafe('CREATE TABLE support.__migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const file of UPS.filter((file) => file < '0005')) {
    await db.sql.begin(async (tx) => {
      await tx.unsafe(readFileSync(join(PKG, 'drizzle', file), 'utf8'));
      await tx`INSERT INTO support.__migrations (name) VALUES (${file})`;
    });
  }
  const rows = await db.sql<{ id: string }[]>`
    INSERT INTO support.tickets (user_id, category, subject, body, status)
    VALUES ('11111111-1111-4111-8111-111111111111', 'account', 'fixture', 'fixture', 'pending') RETURNING id
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error('fixture ticket missing');
  await db.sql`INSERT INTO support.ticket_events (ticket_id, sequence, kind, actor_id, actor_role, from_status, to_status)
    VALUES (${id}, 1, 'status_changed', '33333333-3333-4333-8333-333333333333', 'operator', 'open', 'pending')`;
  return id;
}

async function installBookkeepingTripwire(sql: postgres.Sql, event: 'INSERT' | 'DELETE'): Promise<void> {
  await sql.unsafe(`
    CREATE OR REPLACE FUNCTION support.reject_migration_bookkeeping()
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
    BEFORE ${event} ON support.__migrations
    FOR EACH ROW
    EXECUTE FUNCTION support.reject_migration_bookkeeping()
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

describe.skipIf(!admin)('support migration file and ledger row are one transaction', () => {
  afterAll(async () => {
    await admin?.sql.end({ timeout: 1 }).catch(() => undefined);
  });

  it('rolls the file back when the ledger insert fails', async () => {
    const db = await provision();
    try {
      await db.sql.unsafe(`
        CREATE TABLE support.__migrations (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await installBookkeepingTripwire(db.sql, 'INSERT');
      const result = await runMigrate(db.url);
      expect(result.code, text(result)).not.toBe(0);
      expect(text(result)).toContain('bookkeeping refused');
      const tables = await db.sql<{ reg: string | null }[]>`
        SELECT to_regclass('support.tickets')::text AS reg
      `;
      expect(tables[0]?.reg ?? null).toBeNull();
      const rows = await db.sql`SELECT name FROM support.__migrations`;
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
      expect(await versionGuard(db.sql)).toContain('kb_articles_version_locked');
      await installBookkeepingTripwire(db.sql, 'DELETE');
      const down = await runMigrate(db.url, ['--down']);
      expect(down.code, text(down)).not.toBe(0);
      expect(text(down)).toContain('bookkeeping refused');
      expect(await versionGuard(db.sql)).toContain('kb_articles_version_locked');
      const row = await db.sql`
        SELECT name FROM support.__migrations WHERE name = '0008_kb_article_versions_immutable.sql'
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
        CREATE TABLE support.__migrations (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await gate.unsafe('BEGIN');
      await gate.unsafe('LOCK TABLE support.__migrations IN ACCESS EXCLUSIVE MODE');
      const pending = Promise.all([runMigrate(db.url), runMigrate(db.url)]);
      await waitForLockWaits(db.sql, 2);
      await gate.unsafe('COMMIT');
      const [first, second] = await pending;
      expect(first.code, text(first)).toBe(0);
      expect(second.code, text(second)).toBe(0);
      const rows = await db.sql<{ name: string }[]>`
        SELECT name FROM support.__migrations ORDER BY name
      `;
      expect(rows.map((row) => row.name)).toEqual(UPS);
      const again = await runMigrate(db.url);
      expect(again.code, text(again)).toBe(0);
      expect(again.stdout).toContain('already applied');
      const count = await db.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM support.__migrations
      `;
      expect(count[0]?.n).toBe(UPS.length);
    } finally {
      await gate.unsafe('ROLLBACK').catch(() => undefined);
      await gate.end({ timeout: 1 }).catch(() => undefined);
      await db.drop();
    }
  }, 90_000);
  it('bootstraps the journal safely for two fresh runners', async () => {
    const db = await provision();
    const gate = postgres(db.url, { max: 1, onnotice: () => undefined });
    let pending: Promise<Run[]> | undefined;
    try {
      await gate.unsafe('BEGIN');
      await gate`SELECT pg_advisory_xact_lock(hashtext('support.__migrations.bootstrap'))`;
      pending = Promise.all([runMigrate(db.url), runMigrate(db.url)]);
      await waitForLockWaits(db.sql, 2);
      await gate.unsafe('COMMIT');
      const results = await pending;
      for (const result of results) expect(result.code, text(result)).toBe(0);
      const rows = await db.sql<{ name: string }[]>`SELECT name FROM support.__migrations ORDER BY name`;
      expect(rows.map((row) => row.name)).toEqual(UPS);
    } finally {
      await gate.unsafe('ROLLBACK').catch(() => undefined);
      await pending?.catch(() => undefined);
      await gate.end({ timeout: 1 });
      await db.drop();
    }
  }, 60_000);

  it('upgrades populated public0000–0004 without rewriting history, then reverses and reapplies', async () => {
    const db = await provision();
    try {
      const id = await publicBase(db);
      await db.sql`INSERT INTO support.case_files (ticket_id, escalated_by, reason, citations, grounding, summary)
        VALUES (${id}, '33333333-3333-4333-8333-333333333333', 'technical',
          ${db.sql.json([{ kind: 'kb_article', ref: 'kb-account-access', digest: 'a'.repeat(64), readAt: '2026-10-11T00:00:00.000Z' }])},
          ${db.sql.json({ status: 'unread', reason: 'not_attempted' })}, 'fixture')`;
      const before = await db.sql`SELECT row_to_json(e)::text AS body FROM support.ticket_events e WHERE ticket_id = ${id}`;
      const up = await runMigrate(db.url);
      expect(up.code, text(up)).toBe(0);
      const after = await db.sql`SELECT row_to_json(e)::text AS body FROM support.ticket_events e WHERE ticket_id = ${id}`;
      expect(after).toEqual(before);
      expect(await versionGuard(db.sql)).toContain('kb_articles_version_locked');
      const rows = await db.sql<
        { confdeltype: string }[]
      >`SELECT confdeltype FROM pg_constraint WHERE conname = 'ticket_events_ticket_id_fkey'`;
      expect(rows[0]?.confdeltype).toBe('r');
      const down = await runMigrate(db.url, ['--down']);
      expect(down.code, text(down)).toBe(0);
      const journal = await db.sql`SELECT name FROM support.__migrations`;
      expect(journal).toHaveLength(0);
      const again = await runMigrate(db.url);
      expect(again.code, text(again)).toBe(0);
      expect(await versionGuard(db.sql)).toContain('kb_articles_version_locked');
    } finally {
      await db.drop();
    }
  }, 60_000);

  it.each(['status', 'citation'])(
    'refuses invalid old %s rows and rolls back only the failed file',
    async (kind) => {
      const db = await provision();
      try {
        const id = await publicBase(db);
        if (kind === 'status') {
          await db.sql`INSERT INTO support.ticket_events (ticket_id, sequence, kind, actor_id, actor_role, from_status, to_status)
          VALUES (${id}, 2, 'status_changed', '33333333-3333-4333-8333-333333333333', 'operator', 'unknown-old-status', 'pending')`;
        } else {
          await db.sql`INSERT INTO support.case_files (ticket_id, escalated_by, reason, citations, grounding, summary)
          VALUES (${id}, '33333333-3333-4333-8333-333333333333', 'technical', ${db.sql.json([{}])}, ${db.sql.json({ status: 'unread', reason: 'not_attempted' })}, 'fixture')`;
        }
        const before =
          kind === 'status'
            ? await db.sql`SELECT row_to_json(e)::text AS body FROM support.ticket_events e WHERE ticket_id = ${id} ORDER BY sequence`
            : await db.sql`SELECT row_to_json(e)::text AS body FROM support.case_files e WHERE ticket_id = ${id}`;
        const failed = await runMigrate(db.url);
        expect(failed.code, text(failed)).not.toBe(0);
        expect(text(failed)).toContain(kind === 'status' ? 'ticket_events_status_pair_ck' : 'case_files_grounded_ck');
        const failedFile = kind === 'status' ? '0006_support_status_pair_enum.sql' : '0007_support_citation_shape.sql';
        expect(await db.sql`SELECT name FROM support.__migrations WHERE name = ${failedFile}`).toHaveLength(0);
        expect(await db.sql`SELECT name FROM support.__migrations WHERE name = '0005_support_audit_delete_refused.sql'`).toHaveLength(1);
        const after =
          kind === 'status'
            ? await db.sql`SELECT row_to_json(e)::text AS body FROM support.ticket_events e WHERE ticket_id = ${id} ORDER BY sequence`
            : await db.sql`SELECT row_to_json(e)::text AS body FROM support.case_files e WHERE ticket_id = ${id}`;
        expect(after).toEqual(before);
        if (kind === 'citation') {
          const functions = await db.sql<
            { name: string | null }[]
          >`SELECT to_regprocedure('support.case_file_is_grounded(jsonb,jsonb)')::text AS name`;
          expect(functions[0]?.name).toBeNull();
        }
      } finally {
        await db.drop();
      }
    },
    60_000,
  );
});
