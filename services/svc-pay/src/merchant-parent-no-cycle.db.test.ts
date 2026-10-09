import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * merchants_parent_not_self only rejects a merchant whose parent_merchant_id
 * equals its own id. A cycle of length two or more stayed a valid update.
 * 0027 walks parent_merchant_id from the new parent and refuses when that
 * walk reaches the row being written, repeats an id, or passes a finite cap
 * without a null parent.
 *
 * Prior forward files are applied first. Pay SQL is schema-qualified and
 * rewritten onto a schema in the database TEST_DATABASE_URL names. This file
 * does not start Postgres and does not create a database.
 *
 * The migration moves no value and writes no merchant rows.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const CLOSING = '0027_pay_merchant_parent_no_cycle.sql';
const CLOSING_DOWN = '0027_pay_merchant_parent_no_cycle.down.sql';

const SELF_CK = 'merchants_parent_not_self';
const CYCLE_TRG = 'merchants_parent_no_cycle_trg';
const CYCLE_FN = 'merchants_parent_no_cycle';

const priorMigrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql') && f !== CLOSING)
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error('TEST_DATABASE_URL is unset; refusing to guess a database for merchant parent cycles');
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

describe('a merchant parent cycle of any length is refused', () => {
  let sql: postgres.Sql | undefined;
  let admin: postgres.Sql | undefined;
  let schema = '';

  beforeAll(async () => {
    const url = testDatabaseUrl();
    admin = postgres(url, { max: 1, onnotice: () => undefined });
    const current = one(await admin<Array<{ db: string }>>`SELECT current_database() AS db`, 'current database');
    if (!current.db.endsWith('_test')) {
      throw new Error(`refusing to migrate merchant parent cycles on database ${current.db}`);
    }

    schema = `test_pay_l872_${process.pid}`;
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

    // 0009 adds merchants_parent_not_self only when that conname is absent
    // anywhere in the database. A shared database that already owns the name
    // on pay.merchants skips the ADD, so this rewritten schema must add the
    // same check itself.
    const selfCheck = await sql<Array<{ conname: string }>>`
      SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ${schema}
         AND c.relname = 'merchants'
         AND con.conname = ${SELF_CK}
    `;
    if (selfCheck.length === 0) {
      if (!/^[a-z][a-z0-9_]*$/i.test(schema)) {
        throw new Error(`refusing to add ${SELF_CK} on ${schema}`);
      }
      await sql.unsafe(
        `ALTER TABLE "${schema}"."merchants" ADD CONSTRAINT "${SELF_CK}" CHECK ("parent_merchant_id" IS NULL OR "parent_merchant_id" <> "id")`,
      );
    }
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 }).catch(() => undefined);
    if (admin && schema) {
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    }
    await admin?.end({ timeout: 5 }).catch(() => undefined);
  }, 30_000);

  it('refuses a self-parent and a two-node cycle, and stores a straight parent link', async () => {
    const db = sql;
    if (!db || !schema) throw new Error('test database was not opened');

    const raw = readFileSync(join(drizzleDir, CLOSING), 'utf8');
    const statements = stripSqlComments(raw);
    const downRaw = readFileSync(join(drizzleDir, CLOSING_DOWN), 'utf8');
    const downStatements = stripSqlComments(downRaw);

    expect(raw).toContain('MAX_SUBMERCHANT_DEPTH');
    expect(raw).toContain('services/svc-pay/src/submerchants.ts');
    expect(statements).toContain('BEFORE INSERT OR UPDATE OF "parent_merchant_id"');
    expect(statements).toContain("ERRCODE = '23514'");
    expect(statements).toContain('parent_walk_cap constant integer := 32');
    expect(statements).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(statements).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(statements).not.toMatch(/\bUPDATE\s+(?:"[\w]+"\.)?"merchants"\s+SET\b/i);
    expect(downStatements).toContain('DROP TRIGGER IF EXISTS "merchants_parent_no_cycle_trg"');
    expect(downStatements).toContain('DROP FUNCTION IF EXISTS "pay"."merchants_parent_no_cycle"()');
    expect(downStatements).not.toContain(SELF_CK);
    expect(downStatements).not.toMatch(/\bINSERT\b/i);
    expect(downStatements).not.toMatch(/\bUPDATE\b/i);
    expect(downStatements).not.toMatch(/\bDELETE\b/i);

    const closing = rewritePaySchema(raw, schema);
    const closingDown = rewritePaySchema(downRaw, schema);

    async function parentOf(id: string): Promise<string | null> {
      const row = one(
        await db<Array<{ parent_merchant_id: string | null }>>`
          SELECT parent_merchant_id FROM merchants WHERE id = ${id}
        `,
        'merchant parent',
      );
      return row.parent_merchant_id;
    }

    async function constraintNames(): Promise<string[]> {
      const rows = await db<Array<{ conname: string }>>`
        SELECT con.conname
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ${schema}
           AND c.relname = 'merchants'
           AND con.contype = 'c'
         ORDER BY con.conname
      `;
      return rows.map((row) => row.conname);
    }

    async function triggerNames(): Promise<string[]> {
      const rows = await db<Array<{ tgname: string }>>`
        SELECT t.tgname
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ${schema}
           AND c.relname = 'merchants'
           AND NOT t.tgisinternal
         ORDER BY t.tgname
      `;
      return rows.map((row) => row.tgname);
    }

    async function functionNames(): Promise<string[]> {
      const rows = await db<Array<{ proname: string }>>`
        SELECT p.proname
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = ${schema}
           AND p.proname = ${CYCLE_FN}
      `;
      return rows.map((row) => row.proname);
    }

    async function expectRefused(run: () => Promise<unknown>, messageIncludes: string): Promise<void> {
      const error = await run().then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).toMatchObject({ code: '23514' });
      expect(String((error as { message?: string }).message)).toContain(messageIncludes);
    }

    expect(await constraintNames()).toContain(SELF_CK);
    expect(await triggerNames()).not.toContain(CYCLE_TRG);

    await db.unsafe(closing);
    expect(await constraintNames()).toContain(SELF_CK);
    expect(await triggerNames()).toContain(CYCLE_TRG);
    expect(await functionNames()).toEqual([CYCLE_FN]);

    const selfId = randomUUID();
    await expectRefused(
      () => db`
        INSERT INTO merchants (id, user_id, parent_merchant_id)
        VALUES (${selfId}, 'l872-self', ${selfId})
      `,
      CYCLE_FN,
    );
    const selfRows = await db<Array<{ id: string }>>`
      SELECT id FROM merchants WHERE id = ${selfId}
    `;
    expect(selfRows).toEqual([]);

    const merchantA = one(
      await db<Array<{ id: string }>>`
        INSERT INTO merchants (user_id)
        VALUES ('l872-a')
        RETURNING id
      `,
      'merchant A',
    );
    expect(await parentOf(merchantA.id)).toBeNull();

    await expectRefused(
      () => db`
        UPDATE merchants
           SET parent_merchant_id = ${merchantA.id}
         WHERE id = ${merchantA.id}
      `,
      CYCLE_FN,
    );
    expect(await parentOf(merchantA.id)).toBeNull();

    const merchantB = one(
      await db<Array<{ id: string }>>`
        INSERT INTO merchants (user_id, parent_merchant_id)
        VALUES ('l872-b', ${merchantA.id})
        RETURNING id
      `,
      'merchant B',
    );
    expect(await parentOf(merchantB.id)).toBe(merchantA.id);

    await expectRefused(
      () => db`
        UPDATE merchants
           SET parent_merchant_id = ${merchantB.id}
         WHERE id = ${merchantA.id}
      `,
      'walk reached this merchant',
    );
    expect(await parentOf(merchantA.id)).toBeNull();
    expect(await parentOf(merchantB.id)).toBe(merchantA.id);

    await db.unsafe(closingDown);
    expect(await triggerNames()).not.toContain(CYCLE_TRG);
    expect(await functionNames()).toEqual([]);
    expect(await constraintNames()).toContain(SELF_CK);

    await expectRefused(
      () => db`
        UPDATE merchants
           SET parent_merchant_id = ${merchantA.id}
         WHERE id = ${merchantA.id}
      `,
      SELF_CK,
    );
    expect(await parentOf(merchantA.id)).toBeNull();

    await db`
      UPDATE merchants
         SET parent_merchant_id = ${merchantB.id}
       WHERE id = ${merchantA.id}
    `;
    expect(await parentOf(merchantA.id)).toBe(merchantB.id);
    expect(await parentOf(merchantB.id)).toBe(merchantA.id);
  });
});
