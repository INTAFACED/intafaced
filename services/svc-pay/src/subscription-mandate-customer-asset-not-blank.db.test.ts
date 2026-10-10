import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * subscription_mandates.customer_id and asset_id are text NOT NULL.
 * subscriptions.path already refuses a blank with length(btrim(path)) > 0.
 * These two columns do not. NOT NULL still admits '' and a string of spaces.
 * status defaults to active and amount must be positive, so a mandate can
 * authorize a charge with a blank customer or a blank asset. 0029 adds
 * CHECK (length(btrim(column)) > 0) on each column. The columns stay text.
 * The migration does not invent a customer id, an asset id, or an amount,
 * and it does not create an enum.
 *
 * Prior forward files are applied first. Pay SQL is schema-qualified and
 * rewritten onto a schema in the database TEST_DATABASE_URL names. This file
 * does not start Postgres and does not create a database.
 *
 * The fixture customer and the fixture asset live only in this test.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const CLOSING = '0029_pay_subscription_mandate_customer_asset_not_blank.sql';
const CLOSING_DOWN = '0029_pay_subscription_mandate_customer_asset_not_blank.down.sql';

const CUSTOMER_CK = 'subscription_mandates_customer_id_not_blank';
const ASSET_CK = 'subscription_mandates_asset_id_not_blank';
const AMOUNT_CK = 'subscription_mandates_amount_positive';
const CEILING_CK = 'subscription_mandates_ceiling_ok';
const ENDS_CK = 'subscription_mandates_ends_after_starts';

/** Checks 0010 already installs. 0029 must leave every one of them in place. */
const BASE_CHECKS = [AMOUNT_CK, CEILING_CK, ENDS_CK];

const WITH_BLANK_CHECKS = [AMOUNT_CK, ASSET_CK, CEILING_CK, CUSTOMER_CK, ENDS_CK];

/** Space-only. btrim removes spaces, so this is blank for the check. */
const SPACES = '   ';

const FIXTURE_CUSTOMER = 'l874-fixture-customer';
const FIXTURE_ASSET = 'l874-fixture-asset';
/** Positive amount string already used by charge-cycle.db.test.ts. */
const AMOUNT = '10';
const STARTS_AT = new Date('2026-01-15T00:00:00.000Z');

const priorMigrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql') && f !== CLOSING)
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error('TEST_DATABASE_URL is unset; refusing to guess a database for subscription mandates');
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

describe('subscription mandate customer_id and asset_id are non-blank', () => {
  let sql: postgres.Sql | undefined;
  let admin: postgres.Sql | undefined;
  let schema = '';

  beforeAll(async () => {
    const url = testDatabaseUrl();
    admin = postgres(url, { max: 1, onnotice: () => undefined });
    const current = one(await admin<Array<{ db: string }>>`SELECT current_database() AS db`, 'current database');
    if (!current.db.endsWith('_test')) {
      throw new Error(`refusing to migrate subscription mandates on database ${current.db}`);
    }
    if (current.db === 'postgres') {
      throw new Error('refusing to migrate subscription mandates on database postgres');
    }

    schema = `test_pay_l874_${process.pid}`;
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

  it('refuses an empty or space-only customer or asset, and stores one non-blank mandate', async () => {
    const db = sql;
    if (!db || !schema) throw new Error('test database was not opened');

    async function checkNames(): Promise<string[]> {
      const rows = await db<Array<{ conname: string }>>`
        SELECT con.conname
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ${schema}
           AND c.relname = 'subscription_mandates'
           AND con.contype = 'c'
         ORDER BY con.conname
      `;
      return rows.map((row) => row.conname);
    }

    async function countMandates(): Promise<string> {
      const rows = await db<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM subscription_mandates
      `;
      return one(rows, 'mandate count').n;
    }

    const merchant = one(
      await db<Array<{ id: string }>>`
        INSERT INTO merchants (user_id)
        VALUES ('l874-merchant')
        RETURNING id
      `,
      'merchant',
    );

    async function expectRefused(customerId: string, assetId: string, constraint: string): Promise<void> {
      const error = await db`
        INSERT INTO subscription_mandates (
          merchant_id, customer_id, asset_id, amount, cadence, starts_at
        ) VALUES (
          ${merchant.id},
          ${customerId},
          ${assetId},
          ${AMOUNT}::numeric,
          'monthly',
          ${STARTS_AT}
        )
      `.then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).toMatchObject({ code: '23514', constraint_name: constraint });
    }

    expect(await checkNames()).toEqual(BASE_CHECKS);

    const closingRaw = readFileSync(join(drizzleDir, CLOSING), 'utf8');
    const closingDownRaw = readFileSync(join(drizzleDir, CLOSING_DOWN), 'utf8');
    const statements = stripSqlComments(closingRaw);
    expect(statements).toMatch(/length\(btrim\("customer_id"\)\)\s*>\s*0/);
    expect(statements).toMatch(/length\(btrim\("asset_id"\)\)\s*>\s*0/);
    expect(statements).toContain(`ADD CONSTRAINT "${CUSTOMER_CK}"`);
    expect(statements).toContain(`ADD CONSTRAINT "${ASSET_CK}"`);
    expect(statements).toContain('"pay"."subscription_mandates"');
    expect(statements).not.toMatch(/\bINSERT\b/i);
    expect(statements).not.toMatch(/\bUPDATE\b/i);
    expect(statements).not.toMatch(/\bDELETE\b/i);
    expect(statements).not.toMatch(/\bCREATE\s+TYPE\b/i);
    expect(statements).not.toMatch(/\bENUM\b/i);
    expect(statements).not.toMatch(/\bamount\b/i);
    expect(statements).not.toMatch(/\bceiling\b/i);
    const downStatements = stripSqlComments(closingDownRaw);
    expect(downStatements).toContain(`DROP CONSTRAINT IF EXISTS "${CUSTOMER_CK}"`);
    expect(downStatements).toContain(`DROP CONSTRAINT IF EXISTS "${ASSET_CK}"`);
    expect(downStatements).not.toContain(AMOUNT_CK);
    expect(downStatements).not.toContain(CEILING_CK);
    expect(downStatements).not.toMatch(/\bINSERT\b/i);
    expect(downStatements).not.toMatch(/\bUPDATE\b/i);
    expect(downStatements).not.toMatch(/\bDELETE\b/i);

    await db.unsafe(rewritePaySchema(closingRaw, schema));
    expect(await checkNames()).toEqual(WITH_BLANK_CHECKS);

    await expectRefused('', FIXTURE_ASSET, CUSTOMER_CK);
    await expectRefused(SPACES, FIXTURE_ASSET, CUSTOMER_CK);
    await expectRefused(FIXTURE_CUSTOMER, '', ASSET_CK);
    await expectRefused(FIXTURE_CUSTOMER, SPACES, ASSET_CK);
    expect(await countMandates()).toBe('0');

    const stored = one(
      await db<Array<{ id: string; customer_id: string; asset_id: string; status: string; amount_ok: boolean }>>`
        INSERT INTO subscription_mandates (
          merchant_id, customer_id, asset_id, amount, cadence, starts_at
        ) VALUES (
          ${merchant.id},
          ${FIXTURE_CUSTOMER},
          ${FIXTURE_ASSET},
          ${AMOUNT}::numeric,
          'monthly',
          ${STARTS_AT}
        )
        RETURNING id, customer_id, asset_id, status::text AS status, (amount = ${AMOUNT}::numeric) AS amount_ok
      `,
      'non-blank mandate',
    );
    expect(stored.customer_id).toBe(FIXTURE_CUSTOMER);
    expect(stored.asset_id).toBe(FIXTURE_ASSET);
    expect(stored.status).toBe('active');
    expect(stored.amount_ok).toBe(true);
    expect(await countMandates()).toBe('1');

    await db.unsafe(rewritePaySchema(closingDownRaw, schema));
    expect(await checkNames()).toEqual(BASE_CHECKS);
    expect(await countMandates()).toBe('1');
  });
});
