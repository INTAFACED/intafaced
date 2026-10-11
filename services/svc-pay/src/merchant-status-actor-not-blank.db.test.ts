import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * merchant_status_events.actor_id and actor_scope are text NOT NULL. 0006
 * already refuses a blank reason. These two columns do not. NOT NULL still
 * admits '' and a string of spaces. A blank actor fails the question the
 * history exists to answer. 0026 adds CHECK (length(btrim(column)) > 0) on
 * each column.
 *
 * The table is append-only. A blank row already stored cannot be repaired in
 * place, so a failed ADD CONSTRAINT leaves that row. This file clears a
 * fixture with TRUNCATE, which the migration does not do.
 *
 * Prior forward files are applied first. Pay SQL is schema-qualified and
 * rewritten onto a schema in the database TEST_DATABASE_URL names. This file
 * does not start Postgres and does not create a database.
 *
 * The fixture actor lives only in this test. The migration does not invent one.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const CLOSING = '0026_pay_merchant_status_actor_not_blank.sql';
const CLOSING_DOWN = '0026_pay_merchant_status_actor_not_blank.down.sql';

const ACTOR_ID_CK = 'merchant_status_events_actor_id_not_blank';
const ACTOR_SCOPE_CK = 'merchant_status_events_actor_scope_not_blank';
const REASON_CK = 'merchant_status_events_reason_not_blank';

/** Space-only. btrim removes spaces, so this is blank for the check. */
const SPACES = '   ';

const FIXTURE_ACTOR_ID = 'l871-fixture-actor';
const FIXTURE_ACTOR_SCOPE = 'l871-fixture-scope';
const FIXTURE_REASON = 'l871 fixture reason';

const priorMigrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql') && f !== CLOSING)
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error('TEST_DATABASE_URL is unset; refusing to guess a database for merchant status actors');
  }
  return url;
}

function rewritePaySchema(sql: string, schema: string): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(schema)) {
    throw new Error(`refusing to rewrite pay SQL onto ${schema}`);
  }
  return sql.replaceAll('"pay"', `"${schema}"`).replace(/\bpay\./g, `${schema}.`);
}

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function one<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`expected ${what}`);
  return row;
}

interface StoredActor {
  id: string;
  actor_id: string;
  actor_scope: string;
  reason: string;
}

describe('merchant status actor_id and actor_scope are non-blank', () => {
  let sql: postgres.Sql | undefined;
  let admin: postgres.Sql | undefined;
  let schema = '';

  beforeAll(async () => {
    const url = testDatabaseUrl();
    admin = postgres(url, { max: 1, onnotice: () => undefined });
    const current = one(await admin<Array<{ db: string }>>`SELECT current_database() AS db`, 'current database');
    if (!current.db.endsWith('_test')) {
      throw new Error(`refusing to migrate merchant status actors on database ${current.db}`);
    }

    schema = `test_pay_l871_${process.pid}`;
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);

    sql = postgres(url, {
      max: 1,
      connection: { search_path: `${schema},public` },
      onnotice: () => undefined,
    });
    for (const migration of priorMigrations) {
      await sql.unsafe(rewritePaySchema(migration, schema));
    }
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 }).catch(() => undefined);
    if (admin && schema) {
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    }
    await admin?.end({ timeout: 5 }).catch(() => undefined);
  }, 30_000);

  it('refuses an empty or space-only actor, stores a non-blank pair, and leaves an already-blank row when the check cannot be added', async () => {
    const db = (() => {
      if (!sql) throw new Error('Native test database was not opened');
      return sql;
    })();
    if (!db || !schema) throw new Error('test database was not opened');

    const closing = rewritePaySchema(readFileSync(join(drizzleDir, CLOSING), 'utf8'), schema);
    const closingDown = rewritePaySchema(readFileSync(join(drizzleDir, CLOSING_DOWN), 'utf8'), schema);
    const statements = stripSqlComments(readFileSync(join(drizzleDir, CLOSING), 'utf8'));
    expect(statements).toMatch(/length\(btrim\("actor_id"\)\)\s*>\s*0/);
    expect(statements).toMatch(/length\(btrim\("actor_scope"\)\)\s*>\s*0/);
    expect(statements).not.toMatch(/\bINSERT\b/i);
    expect(statements).not.toMatch(/\bUPDATE\b/i);
    expect(statements).not.toMatch(/\bDELETE\b/i);

    const merchant = one(
      await db<Array<{ id: string }>>`
        INSERT INTO merchants (user_id)
        VALUES ('l871-status-actor')
        RETURNING id
      `,
      'merchant',
    );

    async function insertEvent(actorId: string, actorScope: string): Promise<string> {
      const id = randomUUID();
      await db`
        INSERT INTO merchant_status_events (id, merchant_id, from_status, to_status, reason, actor_id, actor_scope)
        VALUES (
          ${id},
          ${merchant.id},
          'pending'::merchant_status,
          'suspended'::merchant_status,
          ${FIXTURE_REASON},
          ${actorId},
          ${actorScope}
        )
      `;
      return id;
    }

    async function stored(id: string): Promise<StoredActor | undefined> {
      const rows = await db<StoredActor[]>`
        SELECT id, actor_id, actor_scope, reason
          FROM merchant_status_events
         WHERE id = ${id}
      `;
      return rows[0];
    }

    async function checkNames(): Promise<string[]> {
      const rows = await db<Array<{ conname: string }>>`
        SELECT con.conname
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ${schema}
           AND c.relname = 'merchant_status_events'
           AND con.contype = 'c'
         ORDER BY con.conname
      `;
      return rows.map((row) => row.conname);
    }

    async function expectRefused(actorId: string, actorScope: string, constraint: string): Promise<void> {
      const id = randomUUID();
      const error = await db`
        INSERT INTO merchant_status_events (id, merchant_id, from_status, to_status, reason, actor_id, actor_scope)
        VALUES (
          ${id},
          ${merchant.id},
          'pending'::merchant_status,
          'suspended'::merchant_status,
          ${FIXTURE_REASON},
          ${actorId},
          ${actorScope}
        )
      `.then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).toMatchObject({ code: '23514' });
      expect(String((error as { message?: string }).message)).toContain(constraint);
      expect(await stored(id)).toBeUndefined();
    }

    expect(await checkNames()).toEqual([REASON_CK]);

    const blankActorId = await insertEvent('', FIXTURE_ACTOR_SCOPE);
    const blankActorBefore = one(
      await db<StoredActor[]>`
      SELECT id, actor_id, actor_scope, reason
        FROM merchant_status_events
       WHERE id = ${blankActorId}
    `,
      'blank actor_id before the check',
    );
    expect(blankActorBefore.actor_id).toBe('');
    await expect(db.unsafe(closing)).rejects.toThrow(new RegExp(ACTOR_ID_CK));
    const blankActorAfter = one(
      await db<StoredActor[]>`
      SELECT id, actor_id, actor_scope, reason
        FROM merchant_status_events
       WHERE id = ${blankActorId}
    `,
      'blank actor_id after the refused check',
    );
    expect(blankActorAfter).toEqual(blankActorBefore);
    expect(await checkNames()).toEqual([REASON_CK]);
    await db`TRUNCATE merchant_status_events`;

    const blankScopeId = await insertEvent(FIXTURE_ACTOR_ID, SPACES);
    const blankScopeBefore = one(
      await db<StoredActor[]>`
      SELECT id, actor_id, actor_scope, reason
        FROM merchant_status_events
       WHERE id = ${blankScopeId}
    `,
      'blank actor_scope before the check',
    );
    expect(blankScopeBefore.actor_scope).toBe(SPACES);
    await expect(db.unsafe(closing)).rejects.toThrow(new RegExp(ACTOR_SCOPE_CK));
    const blankScopeAfter = one(
      await db<StoredActor[]>`
      SELECT id, actor_id, actor_scope, reason
        FROM merchant_status_events
       WHERE id = ${blankScopeId}
    `,
      'blank actor_scope after the refused check',
    );
    expect(blankScopeAfter).toEqual(blankScopeBefore);
    expect(await checkNames()).toEqual([REASON_CK]);
    await db`TRUNCATE merchant_status_events`;

    await db.unsafe(closing);
    expect(await checkNames()).toEqual([ACTOR_ID_CK, ACTOR_SCOPE_CK, REASON_CK]);

    await expectRefused('', FIXTURE_ACTOR_SCOPE, ACTOR_ID_CK);
    await expectRefused(SPACES, FIXTURE_ACTOR_SCOPE, ACTOR_ID_CK);
    await expectRefused(FIXTURE_ACTOR_ID, '', ACTOR_SCOPE_CK);
    await expectRefused(FIXTURE_ACTOR_ID, SPACES, ACTOR_SCOPE_CK);

    const storedId = await insertEvent(FIXTURE_ACTOR_ID, FIXTURE_ACTOR_SCOPE);
    const pair = one(
      await db<StoredActor[]>`
      SELECT id, actor_id, actor_scope, reason
        FROM merchant_status_events
       WHERE id = ${storedId}
    `,
      'non-blank pair',
    );
    expect(pair.actor_id).toBe(FIXTURE_ACTOR_ID);
    expect(pair.actor_scope).toBe(FIXTURE_ACTOR_SCOPE);
    expect(pair.reason).toBe(FIXTURE_REASON);

    await db.unsafe(closingDown);
    expect(await checkNames()).toEqual([REASON_CK]);
    const afterDown = one(
      await db<StoredActor[]>`
      SELECT id, actor_id, actor_scope, reason
        FROM merchant_status_events
       WHERE id = ${storedId}
    `,
      'non-blank pair after reversal',
    );
    expect(afterDown).toEqual(pair);
  });
});
