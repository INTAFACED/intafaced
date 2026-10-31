import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * merchant_payout_destinations.rail_id is half of the primary key loaded
 * before withdrawHold. 0014 stores it as text NOT NULL. kind and ref already
 * refuse a blank with CHECK (length(btrim(...)) > 0). NOT NULL still admits
 * '' and a string of spaces, so an empty rail_id is stored as a real
 * destination key. 0036 adds CHECK (length(btrim(rail_id)) > 0).
 *
 * A stored blank fails ADD CONSTRAINT and stays. This file clears a fixture
 * with TRUNCATE, which the migration does not do. The migration does not
 * UPDATE stored rows, does not change the kind or ref checks, does not add a
 * unique index on btrim(rail_id), does not invent a rail, a PSP, or an amount,
 * and does not call withdrawHold or post a ledger entry. This table has no
 * amount column. The down file drops only the new constraint.
 *
 * Prior forward files are applied first, including 0014. Pay SQL is
 * schema-qualified and rewritten onto a schema in the database
 * TEST_DATABASE_URL names. This file does not start Postgres and does not
 * create a database.
 *
 * kind 'iban', ref 'ref-1', and rail_id 'rail-1' are fixtures in this test
 * only. kind and ref already satisfy the existing non-blank checks.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const CLOSING = '0036_pay_merchant_payout_destinations_rail_id_not_blank.sql';
const CLOSING_DOWN = '0036_pay_merchant_payout_destinations_rail_id_not_blank.down.sql';

const RAIL_ID_CK = 'merchant_payout_destinations_rail_id_not_blank';
const KIND_CK = 'merchant_payout_destinations_kind_not_blank';
const PENDING_CK = 'merchant_payout_destinations_pending_complete';
const REF_CK = 'merchant_payout_destinations_ref_not_blank';
const MERCHANT_IDX = 'merchant_payout_destinations_merchant_idx';
const TABLE = 'merchant_payout_destinations';

/** Space-only. btrim removes spaces, so this is blank for the check. */
const SPACES = '   ';

/** Fixtures. The migration does not invent a rail. */
const FIXTURE_KIND = 'iban';
const FIXTURE_REF = 'ref-1';
const FIXTURE_RAIL_ID = 'rail-1';

const priorMigrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql') && f !== CLOSING)
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error('TEST_DATABASE_URL is unset; refusing to guess a database for a payout rail id');
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

interface StoredDest {
  merchant_id: string;
  rail_id: string;
  kind: string;
  ref: string;
  created_at: string;
  updated_at: string;
}

interface ConstraintFact {
  conname: string;
  def: string;
}

interface IndexFact {
  name: string;
  def: string;
}

interface Refused {
  code?: string;
  message?: string;
  constraint_name?: string;
}

describe('a payout rail id cannot be blank', () => {
  let sql: postgres.Sql | undefined;
  let admin: postgres.Sql | undefined;
  let schema = '';

  beforeAll(async () => {
    const url = testDatabaseUrl();
    admin = postgres(url, { max: 1, onnotice: () => undefined });
    const current = one(await admin<Array<{ db: string }>>`SELECT current_database() AS db`, 'current database');
    if (current.db === 'postgres') {
      throw new Error('refusing to migrate a payout rail id on database postgres');
    }
    if (!current.db.endsWith('_test')) {
      throw new Error(`refusing to migrate a payout rail id on database ${current.db}`);
    }

    schema = `test_pay_l881_${process.pid}`;
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

  it('refuses an empty or space-only rail id, stores a non-blank rail id, and leaves an already-blank row when the check cannot be added', async () => {
    const db = (() => {
      if (!sql) throw new Error('Native test database was not opened');
      return sql;
    })();
    if (!db || !schema) throw new Error('test database was not opened');
    expect(schema).toMatch(/^test_pay_l881_\d+$/);
    expect(schema).not.toBe('pay');

    const raw = readFileSync(join(drizzleDir, CLOSING), 'utf8');
    const rawDown = readFileSync(join(drizzleDir, CLOSING_DOWN), 'utf8');
    const closing = rewritePaySchema(raw, schema);
    const closingDown = rewritePaySchema(rawDown, schema);
    const statements = stripSqlComments(raw);
    const downStatements = stripSqlComments(rawDown);

    expect(statements.indexOf(`"${RAIL_ID_CK}"`)).toBeGreaterThanOrEqual(0);
    expect(statements).toMatch(new RegExp(`ADD CONSTRAINT "${RAIL_ID_CK}"\\s+CHECK \\(length\\(btrim\\("rail_id"\\)\\) > 0\\)`));
    expect(statements.match(/ALTER TABLE/g)).toHaveLength(1);
    expect(statements.match(/ADD CONSTRAINT/g)).toHaveLength(1);
    expect(statements).not.toMatch(/\bUPDATE\b|\bINSERT\b|\bDELETE\b|\bDROP\b|\bCREATE\b/i);
    expect(statements).not.toMatch(/kind_not_blank|ref_not_blank|\bUNIQUE\b|\bINDEX\b|\bamount\b|\bwithdrawHold\b|\bledger\b/i);
    expect(statements).not.toContain(FIXTURE_KIND);
    expect(statements).not.toContain(FIXTURE_REF);
    expect(statements).not.toContain(FIXTURE_RAIL_ID);
    expect(statements).toContain('"pay"."merchant_payout_destinations"');
    expect(closing).not.toContain('"pay"');
    expect(closing).toContain(`"${schema}"`);
    expect(closingDown).not.toContain('"pay"');
    expect(closingDown).toContain(`"${schema}"`);

    expect(rawDown).toMatch(/intafaced:destructive/);
    expect(downStatements.indexOf(`DROP CONSTRAINT IF EXISTS "${RAIL_ID_CK}"`)).toBeGreaterThanOrEqual(0);
    expect(downStatements.match(/ALTER TABLE/g)).toHaveLength(1);
    expect(downStatements.match(/DROP CONSTRAINT IF EXISTS/g)).toHaveLength(1);
    expect(downStatements).not.toMatch(/\bUPDATE\b|\bINSERT\b|\bDELETE\b|\bDROP\s+COLUMN\b|\bDROP\s+INDEX\b|\bDROP\s+TABLE\b/i);
    expect(downStatements).not.toContain(KIND_CK);
    expect(downStatements).not.toContain(REF_CK);
    expect(downStatements).not.toContain(MERCHANT_IDX);
    expect(downStatements).not.toContain(FIXTURE_KIND);
    expect(downStatements).not.toContain(FIXTURE_REF);
    expect(downStatements).not.toContain(FIXTURE_RAIL_ID);

    async function checks(): Promise<ConstraintFact[]> {
      return db<ConstraintFact[]>`
        SELECT con.conname, pg_get_constraintdef(con.oid) AS def
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ${schema}
           AND c.relname = ${TABLE}
           AND con.contype = 'c'
         ORDER BY con.conname
      `;
    }

    async function primaryKey(): Promise<string> {
      const rows = await db<Array<{ def: string }>>`
        SELECT pg_get_constraintdef(con.oid) AS def
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ${schema}
           AND c.relname = ${TABLE}
           AND con.contype = 'p'
      `;
      return one(rows, 'primary key').def;
    }

    async function indexes(): Promise<IndexFact[]> {
      return db<IndexFact[]>`
        SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS def
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          JOIN pg_class t ON t.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = ${schema}
           AND t.relname = ${TABLE}
         ORDER BY c.relname
      `;
    }

    async function columns(): Promise<string[]> {
      const rows = await db<Array<{ column_name: string }>>`
        SELECT column_name
          FROM information_schema.columns
         WHERE table_schema = ${schema}
           AND table_name = ${TABLE}
         ORDER BY ordinal_position
      `;
      return rows.map((row) => row.column_name);
    }

    async function refused(run: () => Promise<unknown>): Promise<Refused> {
      const error = await run().then(
        () => null,
        (err: unknown) => err,
      );
      return (error ?? {}) as Refused;
    }

    async function countText(): Promise<string> {
      const rows = await db.unsafe<{ n: string }[]>(`SELECT count(*)::text AS n FROM "${schema}"."${TABLE}"`);
      return one(rows, 'destination count').n;
    }

    const merchant = one(
      await db<Array<{ id: string }>>`
        INSERT INTO merchants (user_id)
        VALUES ('l881-merchant')
        RETURNING id::text AS id
      `,
      'merchant',
    );
    const other = one(
      await db<Array<{ id: string }>>`
        INSERT INTO merchants (user_id)
        VALUES ('l881-merchant-b')
        RETURNING id::text AS id
      `,
      'second merchant',
    );
    const third = one(
      await db<Array<{ id: string }>>`
        INSERT INTO merchants (user_id)
        VALUES ('l881-merchant-c')
        RETURNING id::text AS id
      `,
      'third merchant',
    );

    async function insertDest(merchantId: string, railId: string, kind = FIXTURE_KIND, ref = FIXTURE_REF): Promise<StoredDest> {
      return one(
        await db<StoredDest[]>`
          INSERT INTO merchant_payout_destinations (merchant_id, rail_id, kind, ref)
          VALUES (${merchantId}, ${railId}, ${kind}, ${ref})
          RETURNING
            merchant_id::text AS merchant_id,
            rail_id,
            kind,
            ref,
            created_at::text AS created_at,
            updated_at::text AS updated_at
        `,
        'payout destination',
      );
    }

    async function stored(merchantId: string, railId: string): Promise<StoredDest> {
      return one(
        await db<StoredDest[]>`
          SELECT
            merchant_id::text AS merchant_id,
            rail_id,
            kind,
            ref,
            created_at::text AS created_at,
            updated_at::text AS updated_at
            FROM merchant_payout_destinations
           WHERE merchant_id = ${merchantId}
             AND rail_id = ${railId}
        `,
        'stored payout destination',
      );
    }

    const checksBefore = await checks();
    const indexesBefore = await indexes();
    const columnsBefore = await columns();
    const primaryKeyBefore = await primaryKey();
    expect(checksBefore.map((row) => row.conname)).toEqual([KIND_CK, PENDING_CK, REF_CK]);
    expect(checksBefore.find((row) => row.conname === KIND_CK)?.def).toBe('CHECK ((length(btrim(kind)) > 0))');
    expect(checksBefore.find((row) => row.conname === REF_CK)?.def).toBe('CHECK ((length(btrim(ref)) > 0))');
    expect(primaryKeyBefore).toBe('PRIMARY KEY (merchant_id, rail_id)');
    // 0080 appends a uuid page key and its unique index. 0088 appends is_default
    // and one partial unique index. 0090 appends verified and the pending columns.
    // 20261030184034 appends activates_at (J-merchant-02 #5). The rail_id check is unchanged.
    expect(indexesBefore.map((row) => row.name)).toEqual([
      'merchant_payout_destinations_id_idx',
      MERCHANT_IDX,
      'merchant_payout_destinations_one_default_idx',
      'merchant_payout_destinations_pkey',
    ]);
    expect(indexesBefore.every((row) => !/btrim/i.test(row.def))).toBe(true);
    expect(columnsBefore).toEqual([
      'merchant_id',
      'rail_id',
      'kind',
      'ref',
      'created_at',
      'updated_at',
      'id',
      'is_default',
      'verified',
      'verified_at',
      'pending_kind',
      'pending_ref',
      'pending_activates_at',
      'activates_at',
    ]);
    expect(columnsBefore).not.toContain('amount');

    async function expectAddRefused(): Promise<void> {
      const attempt = await refused(() => db.unsafe(closing));
      expect(attempt.code).toBe('23514');
      expect(attempt.message ?? '').toContain(RAIL_ID_CK);
      expect(await checks()).toEqual(checksBefore);
      expect(await indexes()).toEqual(indexesBefore);
      expect(await columns()).toEqual(columnsBefore);
      expect(await primaryKey()).toBe(primaryKeyBefore);
    }

    const blankRail = await insertDest(merchant.id, '');
    expect(blankRail.rail_id).toBe('');
    expect(blankRail.kind).toBe(FIXTURE_KIND);
    expect(blankRail.ref).toBe(FIXTURE_REF);
    await expectAddRefused();
    expect(await stored(merchant.id, '')).toEqual(blankRail);
    await db`TRUNCATE merchant_payout_destinations`;

    const spaceRail = await insertDest(merchant.id, SPACES);
    expect(spaceRail.rail_id).toBe(SPACES);
    expect(spaceRail.kind).toBe(FIXTURE_KIND);
    expect(spaceRail.ref).toBe(FIXTURE_REF);
    await expectAddRefused();
    expect(await stored(merchant.id, SPACES)).toEqual(spaceRail);
    await db`TRUNCATE merchant_payout_destinations`;

    expect(await countText()).toBe('0');

    const kept = await insertDest(merchant.id, FIXTURE_RAIL_ID);
    expect(kept).toMatchObject({
      merchant_id: merchant.id,
      rail_id: FIXTURE_RAIL_ID,
      kind: FIXTURE_KIND,
      ref: FIXTURE_REF,
    });

    await db.unsafe(closing);

    expect(await stored(merchant.id, FIXTURE_RAIL_ID)).toEqual(kept);
    expect(await primaryKey()).toBe(primaryKeyBefore);
    expect(await indexes()).toEqual(indexesBefore);
    expect(await columns()).toEqual(columnsBefore);

    const checksAfter = await checks();
    expect(checksAfter.map((row) => row.conname)).toEqual([KIND_CK, PENDING_CK, RAIL_ID_CK, REF_CK]);
    expect(checksAfter.filter((row) => row.conname !== RAIL_ID_CK)).toEqual(checksBefore);
    expect(checksAfter.find((row) => row.conname === RAIL_ID_CK)?.def).toBe('CHECK ((length(btrim(rail_id)) > 0))');

    async function expectRailRefused(merchantId: string, railId: string): Promise<void> {
      const error = await refused(() => insertDest(merchantId, railId));
      expect(error).toMatchObject({ code: '23514', constraint_name: RAIL_ID_CK });
    }

    await expectRailRefused(merchant.id, '');
    await expectRailRefused(merchant.id, SPACES);
    await expectRailRefused(other.id, '');
    await expectRailRefused(other.id, SPACES);

    const blankKind = await refused(() => insertDest(other.id, FIXTURE_RAIL_ID, '', FIXTURE_REF));
    expect(blankKind).toMatchObject({ code: '23514', constraint_name: KIND_CK });
    const blankRef = await refused(() => insertDest(other.id, FIXTURE_RAIL_ID, FIXTURE_KIND, '   '));
    expect(blankRef).toMatchObject({ code: '23514', constraint_name: REF_CK });

    const inserted = await insertDest(other.id, FIXTURE_RAIL_ID);
    expect(inserted.merchant_id).toBe(other.id);
    expect(inserted.rail_id).toBe(FIXTURE_RAIL_ID);
    expect(inserted.kind).toBe(FIXTURE_KIND);
    expect(inserted.ref).toBe(FIXTURE_REF);
    expect(await countText()).toBe('2');

    await db.unsafe(closingDown);

    expect(await stored(merchant.id, FIXTURE_RAIL_ID)).toEqual(kept);
    expect(await stored(other.id, FIXTURE_RAIL_ID)).toEqual(inserted);
    expect(await checks()).toEqual(checksBefore);
    expect(await indexes()).toEqual(indexesBefore);
    expect(await columns()).toEqual(columnsBefore);
    expect(await primaryKey()).toBe(primaryKeyBefore);

    const blankAfterDown = await insertDest(merchant.id, '');
    const spaceAfterDown = await insertDest(other.id, SPACES);
    expect(blankAfterDown.rail_id).toBe('');
    expect(blankAfterDown.kind).toBe(FIXTURE_KIND);
    expect(blankAfterDown.ref).toBe(FIXTURE_REF);
    expect(spaceAfterDown.rail_id).toBe(SPACES);
    expect(spaceAfterDown.kind).toBe(FIXTURE_KIND);
    expect(spaceAfterDown.ref).toBe(FIXTURE_REF);
    expect(await stored(merchant.id, FIXTURE_RAIL_ID)).toEqual(kept);

    const blankKindAfterDown = await refused(() => insertDest(third.id, FIXTURE_RAIL_ID, '', FIXTURE_REF));
    expect(blankKindAfterDown).toMatchObject({ code: '23514', constraint_name: KIND_CK });
    const blankRefAfterDown = await refused(() => insertDest(third.id, FIXTURE_RAIL_ID, FIXTURE_KIND, ''));
    expect(blankRefAfterDown).toMatchObject({ code: '23514', constraint_name: REF_CK });
  });
});
