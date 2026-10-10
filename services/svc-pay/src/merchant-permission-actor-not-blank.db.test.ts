import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * merchant_permission_events.area, actor_id, and actor_scope are text NOT NULL.
 * 0009 already refuses a blank reason. These three columns do not. NOT NULL
 * still admits '' and a string of spaces. A grant or revoke with a blank area
 * or a blank actor is then a legal authorization event, and the triple index
 * returns it as the latest decision for that key. 0028 adds
 * CHECK (length(btrim(column)) > 0) on each column. area stays text. This
 * file does not name permission areas and does not create an enum.
 *
 * The table is append-only. A blank row already stored cannot be repaired in
 * place, so a failed ADD CONSTRAINT leaves that row. This file clears a
 * fixture with TRUNCATE, which the migration does not do.
 *
 * Prior forward files are applied first. Pay SQL is schema-qualified and
 * rewritten onto a schema in the database TEST_DATABASE_URL names. This file
 * does not start Postgres and does not create a database.
 *
 * The fixture actor and the fixture area live only in this test. The area
 * string is not a permission area. The migration does not invent one.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const CLOSING = '0028_pay_merchant_permission_area_actor_not_blank.sql';
const CLOSING_DOWN = '0028_pay_merchant_permission_area_actor_not_blank.down.sql';

const AREA_CK = 'merchant_permission_events_area_not_blank';
const ACTOR_ID_CK = 'merchant_permission_events_actor_id_not_blank';
const ACTOR_SCOPE_CK = 'merchant_permission_events_actor_scope_not_blank';
const REASON_CK = 'merchant_permission_events_reason_not_blank';
const ACTION_CK = 'merchant_permission_events_action_known';
const NOT_SELF_CK = 'merchant_permission_events_not_self';

/** Checks 0009 already installs. 0028 must leave every one of them in place. */
const BASE_CHECKS = [ACTION_CK, NOT_SELF_CK, REASON_CK];

const WITH_ACTOR_CHECKS = [
  ACTION_CK,
  ACTOR_ID_CK,
  ACTOR_SCOPE_CK,
  AREA_CK,
  NOT_SELF_CK,
  REASON_CK,
];

/** Space-only. btrim removes spaces, so this is blank for the check. */
const SPACES = '   ';

const FIXTURE_AREA = 'l873-fixture-area';
const FIXTURE_ACTOR_ID = 'l873-fixture-actor';
const FIXTURE_ACTOR_SCOPE = 'l873-fixture-scope';
const FIXTURE_REASON = 'l873 fixture reason';

const priorMigrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql') && f !== CLOSING)
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error('TEST_DATABASE_URL is unset; refusing to guess a database for permission actors');
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

interface StoredPermission {
  id: string;
  area: string;
  actor_id: string;
  actor_scope: string;
  reason: string;
}

describe('merchant permission area, actor_id, and actor_scope are non-blank', () => {
  let sql: postgres.Sql | undefined;
  let admin: postgres.Sql | undefined;
  let schema = '';

  beforeAll(async () => {
    const url = testDatabaseUrl();
    admin = postgres(url, { max: 1, onnotice: () => undefined });
    const current = one(await admin<Array<{ db: string }>>`SELECT current_database() AS db`, 'current database');
    if (!current.db.endsWith('_test')) {
      throw new Error(`refusing to migrate permission actors on database ${current.db}`);
    }
    if (current.db === 'postgres') {
      throw new Error('refusing to migrate permission actors on database postgres');
    }

    schema = `test_pay_l873_${process.pid}`;
    if (schema === 'pay') {
      throw new Error('refusing to write the pay schema');
    }
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

  it('refuses a blank area or actor, stores a non-blank triple, and leaves an already-blank row when the check cannot be added', async () => {
    const db = sql;
    if (!db || !schema) throw new Error('test database was not opened');

    const closing = rewritePaySchema(readFileSync(join(drizzleDir, CLOSING), 'utf8'), schema);
    const closingDown = rewritePaySchema(readFileSync(join(drizzleDir, CLOSING_DOWN), 'utf8'), schema);
    const statements = stripSqlComments(readFileSync(join(drizzleDir, CLOSING), 'utf8'));
    const downStatements = stripSqlComments(readFileSync(join(drizzleDir, CLOSING_DOWN), 'utf8'));
    expect(statements).toMatch(/length\(btrim\("area"\)\)\s*>\s*0/);
    expect(statements).toMatch(/length\(btrim\("actor_id"\)\)\s*>\s*0/);
    expect(statements).toMatch(/length\(btrim\("actor_scope"\)\)\s*>\s*0/);
    expect(statements).not.toMatch(/\bINSERT\b/i);
    expect(statements).not.toMatch(/\bUPDATE\b/i);
    expect(statements).not.toMatch(/\bDELETE\b/i);
    expect(statements).not.toMatch(/\bCREATE\s+TYPE\b/i);
    expect(statements).not.toMatch(/\bENUM\b/i);
    expect(statements).not.toMatch(/\bamount\b/i);
    expect(downStatements).toContain(`DROP CONSTRAINT IF EXISTS "${AREA_CK}"`);
    expect(downStatements).toContain(`DROP CONSTRAINT IF EXISTS "${ACTOR_ID_CK}"`);
    expect(downStatements).toContain(`DROP CONSTRAINT IF EXISTS "${ACTOR_SCOPE_CK}"`);
    expect(downStatements).not.toContain(REASON_CK);
    expect(downStatements).not.toMatch(/\bINSERT\b/i);
    expect(downStatements).not.toMatch(/\bUPDATE\b/i);
    expect(downStatements).not.toMatch(/\bDELETE\b/i);

    const grantee = one(
      await db<Array<{ id: string }>>`
        INSERT INTO merchants (user_id)
        VALUES ('l873-grantee')
        RETURNING id
      `,
      'grantee merchant',
    );
    const subject = one(
      await db<Array<{ id: string }>>`
        INSERT INTO merchants (user_id)
        VALUES ('l873-subject')
        RETURNING id
      `,
      'subject merchant',
    );

    async function insertEvent(area: string, actorId: string, actorScope: string): Promise<string> {
      const id = randomUUID();
      await db`
        INSERT INTO merchant_permission_events (
          id, grantee_merchant_id, subject_merchant_id, area, action, reason,
          actor_id, actor_merchant_id, actor_scope
        )
        VALUES (
          ${id},
          ${grantee.id},
          ${subject.id},
          ${area},
          'grant',
          ${FIXTURE_REASON},
          ${actorId},
          ${grantee.id},
          ${actorScope}
        )
      `;
      return id;
    }

    async function stored(id: string): Promise<StoredPermission | undefined> {
      const rows = await db<StoredPermission[]>`
        SELECT id, area, actor_id, actor_scope, reason
          FROM merchant_permission_events
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
           AND c.relname = 'merchant_permission_events'
           AND con.contype = 'c'
         ORDER BY con.conname
      `;
      return rows.map((row) => row.conname);
    }

    async function expectRefused(
      area: string,
      actorId: string,
      actorScope: string,
      constraint: string,
    ): Promise<void> {
      const id = randomUUID();
      const error = await db`
        INSERT INTO merchant_permission_events (
          id, grantee_merchant_id, subject_merchant_id, area, action, reason,
          actor_id, actor_merchant_id, actor_scope
        )
        VALUES (
          ${id},
          ${grantee.id},
          ${subject.id},
          ${area},
          'grant',
          ${FIXTURE_REASON},
          ${actorId},
          ${grantee.id},
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

    expect(await checkNames()).toEqual(BASE_CHECKS);

    const blankAreaId = await insertEvent('', FIXTURE_ACTOR_ID, FIXTURE_ACTOR_SCOPE);
    const blankAreaBefore = one(
      await db<StoredPermission[]>`
        SELECT id, area, actor_id, actor_scope, reason
          FROM merchant_permission_events
         WHERE id = ${blankAreaId}
      `,
      'blank area before the check',
    );
    expect(blankAreaBefore.area).toBe('');
    await expect(db.unsafe(closing)).rejects.toThrow(new RegExp(AREA_CK));
    const blankAreaAfter = one(
      await db<StoredPermission[]>`
        SELECT id, area, actor_id, actor_scope, reason
          FROM merchant_permission_events
         WHERE id = ${blankAreaId}
      `,
      'blank area after the refused check',
    );
    expect(blankAreaAfter).toEqual(blankAreaBefore);
    expect(await checkNames()).toEqual(BASE_CHECKS);
    await db`TRUNCATE merchant_permission_events`;

    const blankActorId = await insertEvent(FIXTURE_AREA, SPACES, FIXTURE_ACTOR_SCOPE);
    const blankActorBefore = one(
      await db<StoredPermission[]>`
        SELECT id, area, actor_id, actor_scope, reason
          FROM merchant_permission_events
         WHERE id = ${blankActorId}
      `,
      'blank actor_id before the check',
    );
    expect(blankActorBefore.actor_id).toBe(SPACES);
    await expect(db.unsafe(closing)).rejects.toThrow(new RegExp(ACTOR_ID_CK));
    const blankActorAfter = one(
      await db<StoredPermission[]>`
        SELECT id, area, actor_id, actor_scope, reason
          FROM merchant_permission_events
         WHERE id = ${blankActorId}
      `,
      'blank actor_id after the refused check',
    );
    expect(blankActorAfter).toEqual(blankActorBefore);
    expect(await checkNames()).toEqual(BASE_CHECKS);
    await db`TRUNCATE merchant_permission_events`;

    const blankScopeId = await insertEvent(FIXTURE_AREA, FIXTURE_ACTOR_ID, '');
    const blankScopeBefore = one(
      await db<StoredPermission[]>`
        SELECT id, area, actor_id, actor_scope, reason
          FROM merchant_permission_events
         WHERE id = ${blankScopeId}
      `,
      'blank actor_scope before the check',
    );
    expect(blankScopeBefore.actor_scope).toBe('');
    await expect(db.unsafe(closing)).rejects.toThrow(new RegExp(ACTOR_SCOPE_CK));
    const blankScopeAfter = one(
      await db<StoredPermission[]>`
        SELECT id, area, actor_id, actor_scope, reason
          FROM merchant_permission_events
         WHERE id = ${blankScopeId}
      `,
      'blank actor_scope after the refused check',
    );
    expect(blankScopeAfter).toEqual(blankScopeBefore);
    expect(await checkNames()).toEqual(BASE_CHECKS);
    await db`TRUNCATE merchant_permission_events`;

    await db.unsafe(closing);
    expect(await checkNames()).toEqual(WITH_ACTOR_CHECKS);

    await expectRefused('', FIXTURE_ACTOR_ID, FIXTURE_ACTOR_SCOPE, AREA_CK);
    await expectRefused(FIXTURE_AREA, SPACES, FIXTURE_ACTOR_SCOPE, ACTOR_ID_CK);
    await expectRefused(FIXTURE_AREA, FIXTURE_ACTOR_ID, '', ACTOR_SCOPE_CK);

    const storedId = await insertEvent(FIXTURE_AREA, FIXTURE_ACTOR_ID, FIXTURE_ACTOR_SCOPE);
    const triple = one(
      await db<StoredPermission[]>`
        SELECT id, area, actor_id, actor_scope, reason
          FROM merchant_permission_events
         WHERE id = ${storedId}
      `,
      'non-blank triple',
    );
    expect(triple.area).toBe(FIXTURE_AREA);
    expect(triple.actor_id).toBe(FIXTURE_ACTOR_ID);
    expect(triple.actor_scope).toBe(FIXTURE_ACTOR_SCOPE);
    expect(triple.reason).toBe(FIXTURE_REASON);

    await db.unsafe(closingDown);
    expect(await checkNames()).toEqual(BASE_CHECKS);
    const afterDown = one(
      await db<StoredPermission[]>`
        SELECT id, area, actor_id, actor_scope, reason
          FROM merchant_permission_events
         WHERE id = ${storedId}
      `,
      'non-blank triple after reversal',
    );
    expect(afterDown).toEqual(triple);
  });
});
