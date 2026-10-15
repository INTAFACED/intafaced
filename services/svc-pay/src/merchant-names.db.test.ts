import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * W4b merchant names (migration 0071) against a real Postgres.
 *
 * Same arrangement as the other svc-pay migration suites: the database
 * TEST_DATABASE_URL names (it must end in `_test`), one throwaway schema per
 * run, every forward file before 0071 applied first, 0071 applied on top of
 * rows that already exist.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const UP = '0071_pay_merchant_names.sql';
const DOWN = '0071_pay_merchant_names.down.sql';

const files = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort();
const prior = files.filter((f) => f < UP).map((f) => readFileSync(join(drizzleDir, f), 'utf8'));
const later = files.filter((f) => f > UP).map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

function rewrite(sql: string, schema: string): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(schema)) throw new Error(`refusing to rewrite pay SQL onto ${schema}`);
  return sql.replaceAll('"pay"', `"${schema}"`).replace(/\bpay\./g, `${schema}.`);
}

/** Invisible formatting characters the CHECKs refuse. U+200D (zero-width joiner) is deliberately absent. */
const INVISIBLE = [
  '\u061c',
  '\u200e',
  '\u200f',
  '\u202a',
  '\u202b',
  '\u202c',
  '\u202d',
  '\u202e',
  '\u2066',
  '\u2067',
  '\u2068',
  '\u2069',
  '\u2028',
  '\u2029',
  '\u200b',
  '\u2060',
  '\ufeff',
];

const NAME_CHECKS = ['merchants_display_name_ck', 'merchants_legal_name_ck'];

describe('merchant names (0071)', () => {
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let schema = '';
  let beforeId = '';

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) throw new Error('TEST_DATABASE_URL is unset; refusing to guess a database for merchant names');
    admin = postgres(url, { max: 1, onnotice: () => undefined });
    const [current] = await admin<Array<{ db: string }>>`SELECT current_database() AS db`;
    if (!current?.db.endsWith('_test')) throw new Error(`refusing to migrate merchant names on database ${current?.db}`);
    schema = `test_pay_names_${process.pid}`;
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    sql = postgres(url, { max: 4, connection: { search_path: `${schema},public` }, onnotice: () => undefined });
    for (const m of prior) await sql.unsafe(rewrite(m, schema));

    // A merchant that exists before the migration.
    const [row] = await sql<Array<{ id: string }>>`
      INSERT INTO ${sql(schema)}.merchants (user_id, status, pricing, settlement_prefs)
      VALUES (${randomUUID()}, 'active', '{"feeBps":250}'::jsonb, '{"businessDetails":{"legalName":"Existing Ltd"}}'::jsonb)
      RETURNING id`;
    beforeId = row!.id;

    await sql.unsafe(rewrite(readFileSync(join(drizzleDir, UP), 'utf8'), schema));
    for (const m of later) await sql.unsafe(rewrite(m, schema));
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 }).catch(() => undefined);
    if (admin && schema) await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await admin?.end({ timeout: 5 }).catch(() => undefined);
  }, 30_000);

  const names = async (id: string) => {
    const [row] = await sql.unsafe<Array<{ display_name: string | null; legal_name: string | null }>>(
      `SELECT display_name, legal_name FROM "${schema}".merchants WHERE id = $1`,
      [id],
    );
    return row;
  };
  const refused = async (work: Promise<unknown>) => {
    try {
      await work;
    } catch (e) {
      return e as { code?: string; constraint_name?: string };
    }
    throw new Error('expected the database to refuse');
  };

  it('adds two nullable text columns and leaves every existing merchant NULL, with no backfill from settlement preferences', async () => {
    const cols = await sql<Array<{ column_name: string; data_type: string; is_nullable: string }>>`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = ${schema} AND table_name = 'merchants' AND column_name IN ('display_name', 'legal_name') ORDER BY column_name`;
    expect(cols).toEqual([
      { column_name: 'display_name', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'legal_name', data_type: 'text', is_nullable: 'YES' },
    ]);
    // The pre-existing row even has a legal name in its preferences: the migration must not copy it.
    expect(await names(beforeId)).toEqual({ display_name: null, legal_name: null });
  });

  it('declares the two CHECK constraints', async () => {
    const found = await sql<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint WHERE conrelid = (${schema + '.merchants'})::regclass AND conname = ANY(${NAME_CHECKS}) ORDER BY conname`;
    expect(found.map((r) => r.conname)).toEqual(NAME_CHECKS);
  });

  it.each([
    ['empty', ''],
    ['spaces only', '    '],
    ['121 characters', 'x'.repeat(121)],
    ['newline', 'a\nb'],
    ['tab', 'a\tb'],
    ['escape', 'a\u001b[31mb'],
    ['DEL', 'a\u007fb'],
    ['C1 control', 'a\u0085b'],
    ['trailing spaces', 'Acme  '],
    ['leading space', ' Acme'],
    ...INVISIBLE.map((c): [string, string] => [`invisible U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`, `a${c}b`]),
  ])('the database itself refuses %s in either name', async (_label, value) => {
    for (const column of ['display_name', 'legal_name']) {
      const err = await refused(
        sql.unsafe(`INSERT INTO "${schema}".merchants (user_id, ${column}) VALUES ($1, $2)`, [randomUUID(), value]),
      );
      expect(err.code, column).toBe('23514');
      expect(err.constraint_name, column).toBe(column === 'display_name' ? 'merchants_display_name_ck' : 'merchants_legal_name_ck');
    }
  });

  it('a name with trailing spaces is refused by a direct INSERT, so the 120 bound is on the real stored length', async () => {
    for (const column of ['display_name', 'legal_name']) {
      const err = await refused(
        sql.unsafe(`INSERT INTO "${schema}".merchants (user_id, ${column}) VALUES ($1, $2)`, [randomUUID(), `${'x'.repeat(120)} `]),
      );
      expect(err.code, column).toBe('23514');
    }
  });

  it('the database accepts a zero-width joiner, so emoji sequences are stored', async () => {
    const id = randomUUID();
    const family = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467} Family Shop';
    await sql.unsafe(`INSERT INTO "${schema}".merchants (user_id, display_name, legal_name) VALUES ($1, $2, $3)`, [id, family, family]);
    const [row] = await sql.unsafe<Array<{ display_name: string }>>(`SELECT display_name FROM "${schema}".merchants WHERE user_id = $1`, [
      id,
    ]);
    expect(row?.display_name).toBe(family);
  });

  it('the database accepts exactly 120 characters and unicode', async () => {
    const id = randomUUID();
    await sql.unsafe(`INSERT INTO "${schema}".merchants (user_id, display_name, legal_name) VALUES ($1, $2, $3)`, [
      id,
      'x'.repeat(120),
      'Café Müller 🍕',
    ]);
    const [row] = await sql.unsafe<Array<{ n: number }>>(
      `SELECT char_length(display_name) AS n FROM "${schema}".merchants WHERE user_id = $1`,
      [id],
    );
    expect(row?.n).toBe(120);
  });

  it('the down migration removes the columns and constraints and can be re-applied', async () => {
    const downSql = readFileSync(join(drizzleDir, DOWN), 'utf8');
    expect(downSql.trim().length).toBeGreaterThan(0);
    await sql.unsafe(rewrite(downSql, schema));
    const gone = await sql<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = ${schema} AND table_name = 'merchants' AND column_name IN ('display_name', 'legal_name')`;
    expect(gone).toEqual([]);
    const checks =
      await sql`SELECT 1 FROM pg_constraint WHERE conrelid = (${schema + '.merchants'})::regclass AND conname = ANY(${NAME_CHECKS})`;
    expect(checks).toHaveLength(0);
    // Up, down and up again: the migration is idempotent and the schema ends as it started.
    await sql.unsafe(rewrite(readFileSync(join(drizzleDir, UP), 'utf8'), schema));
    await sql.unsafe(rewrite(readFileSync(join(drizzleDir, UP), 'utf8'), schema));
    expect(await names(beforeId)).toEqual({ display_name: null, legal_name: null });
  });
});
