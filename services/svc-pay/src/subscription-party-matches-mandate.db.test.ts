import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * subscriptions.mandate_id, merchant_id, and customer_id are independent
 * columns in 0010. mandate_id references subscription_mandates(id) only.
 * merchant_id references merchants(id) only. customer_id is text.
 * subscription_executions reference subscriptions(id) only, so a charge row
 * follows the subscription's party, not the mandate that authorized the amount.
 *
 * 0030 adds UNIQUE (id, merchant_id, customer_id) on subscription_mandates.
 * id is already the primary key, so the unique triple is not a second key.
 * It then adds FOREIGN KEY (mandate_id, merchant_id, customer_id) on
 * subscriptions. The existing mandate_id foreign key stays. A stored
 * mismatch makes ADD CONSTRAINT fail and leaves the row. The down file drops
 * the foreign key, then the unique constraint. No trigger rewrites the columns.
 *
 * Prior forward files are applied first, including 0029. Pay SQL is
 * schema-qualified and rewritten onto a schema in the database
 * TEST_DATABASE_URL names. This file does not start Postgres and does not
 * create a database.
 *
 * Fixture merchants, the fixture customer, and the fixture asset live only
 * in this test. The migration does not insert them. The amount is the
 * positive string already used by charge-cycle.db.test.ts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const CLOSING = '0030_pay_subscription_party_matches_mandate.sql';
const CLOSING_DOWN = '0030_pay_subscription_party_matches_mandate.down.sql';

const MANDATE_PARTY_UQ = 'subscription_mandates_id_merchant_customer_uq';
const SUBSCRIPTION_PARTY_FK = 'subscriptions_mandate_merchant_customer_fk';
const MANDATE_ID_FK = 'subscriptions_mandate_id_fkey';

const FIXTURE_CUSTOMER = 'l875-fixture-customer';
const OTHER_CUSTOMER = 'l875-other-customer';
const FIXTURE_ASSET = 'l875-fixture-asset';
/** Positive amount string already used by charge-cycle.db.test.ts. */
const AMOUNT = '10';
const STARTS_AT = new Date('2026-01-15T00:00:00.000Z');
const NEXT_RUN_AT = new Date('2026-02-15T00:00:00.000Z');

const priorMigrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql') && f !== CLOSING)
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error('TEST_DATABASE_URL is unset; refusing to guess a database for subscription parties');
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

interface StoredSubscription {
  id: string;
  mandate_id: string;
  merchant_id: string;
  customer_id: string;
}

interface ConstraintRow {
  conname: string;
  contype: string;
  def: string;
}

describe('a subscription merchant and customer match the mandate', () => {
  let sql: postgres.Sql | undefined;
  let admin: postgres.Sql | undefined;
  let schema = '';

  beforeAll(async () => {
    const url = testDatabaseUrl();
    admin = postgres(url, { max: 1, onnotice: () => undefined });
    const current = one(await admin<Array<{ db: string }>>`SELECT current_database() AS db`, 'current database');
    if (!current.db.endsWith('_test')) {
      throw new Error(`refusing to migrate subscription parties on database ${current.db}`);
    }
    if (current.db === 'postgres') {
      throw new Error('refusing to migrate subscription parties on database postgres');
    }

    schema = `test_pay_l875_${process.pid}`;
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

  it('refuses a subscription whose merchant or customer differs from the mandate, and stores one that copies both', async () => {
    const db = sql;
    if (!db || !schema) throw new Error('test database was not opened');

    const closing = rewritePaySchema(readFileSync(join(drizzleDir, CLOSING), 'utf8'), schema);
    const closingDown = rewritePaySchema(readFileSync(join(drizzleDir, CLOSING_DOWN), 'utf8'), schema);
    const statements = stripSqlComments(readFileSync(join(drizzleDir, CLOSING), 'utf8'));
    const downStatements = stripSqlComments(readFileSync(join(drizzleDir, CLOSING_DOWN), 'utf8'));

    const uniqueAt = statements.indexOf(MANDATE_PARTY_UQ);
    const foreignAt = statements.indexOf(SUBSCRIPTION_PARTY_FK);
    expect(uniqueAt).toBeGreaterThanOrEqual(0);
    expect(foreignAt).toBeGreaterThan(uniqueAt);
    expect(statements).toMatch(
      new RegExp(
        `ADD CONSTRAINT "${MANDATE_PARTY_UQ}"\\s+UNIQUE \\("id", "merchant_id", "customer_id"\\)`,
      ),
    );
    expect(statements).toMatch(
      new RegExp(
        `ADD CONSTRAINT "${SUBSCRIPTION_PARTY_FK}"\\s+FOREIGN KEY \\("mandate_id", "merchant_id", "customer_id"\\)\\s+REFERENCES "pay"\\."subscription_mandates" \\("id", "merchant_id", "customer_id"\\)`,
      ),
    );
    expect(statements).toContain('"pay"."subscription_mandates"');
    expect(statements).toContain('"pay"."subscriptions"');
    expect(statements).not.toMatch(/\bPRIMARY\s+KEY\b/i);
    expect(statements).not.toMatch(/\bINSERT\b/i);
    expect(statements).not.toMatch(/\bUPDATE\b/i);
    expect(statements).not.toMatch(/\bDELETE\b/i);
    expect(statements).not.toMatch(/\bTRIGGER\b/i);
    expect(statements).not.toMatch(/\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/i);
    expect(statements).not.toMatch(/\bCHECK\b/i);
    expect(statements).not.toMatch(/\bNEW\b/);
    expect(statements).not.toMatch(/\bamount\b/i);
    expect(statements).not.toMatch(/subscription_executions/);
    expect(statements).not.toContain(MANDATE_ID_FK);

    const dropForeignAt = downStatements.indexOf(SUBSCRIPTION_PARTY_FK);
    const dropUniqueAt = downStatements.indexOf(MANDATE_PARTY_UQ);
    expect(dropForeignAt).toBeGreaterThanOrEqual(0);
    expect(dropUniqueAt).toBeGreaterThan(dropForeignAt);
    expect(downStatements).toContain(`DROP CONSTRAINT IF EXISTS "${SUBSCRIPTION_PARTY_FK}"`);
    expect(downStatements).toContain(`DROP CONSTRAINT IF EXISTS "${MANDATE_PARTY_UQ}"`);
    expect(downStatements).not.toContain(MANDATE_ID_FK);
    expect(downStatements).not.toMatch(/\bINSERT\b/i);
    expect(downStatements).not.toMatch(/\bUPDATE\b/i);
    expect(downStatements).not.toMatch(/\bDELETE\b/i);
    expect(downStatements).not.toMatch(/\bTRIGGER\b/i);

    const merchantA = one(
      await db<Array<{ id: string }>>`
        INSERT INTO merchants (user_id)
        VALUES ('l875-merchant-a')
        RETURNING id
      `,
      'merchant A',
    );
    const merchantB = one(
      await db<Array<{ id: string }>>`
        INSERT INTO merchants (user_id)
        VALUES ('l875-merchant-b')
        RETURNING id
      `,
      'merchant B',
    );

    const mandate = one(
      await db<
        Array<{ id: string; merchant_id: string; customer_id: string; amount_ok: boolean }>
      >`
        INSERT INTO subscription_mandates (
          merchant_id, customer_id, asset_id, amount, cadence, starts_at
        ) VALUES (
          ${merchantA.id},
          ${FIXTURE_CUSTOMER},
          ${FIXTURE_ASSET},
          ${AMOUNT}::numeric,
          'monthly',
          ${STARTS_AT}
        )
        RETURNING id, merchant_id, customer_id, (amount = ${AMOUNT}::numeric) AS amount_ok
      `,
      'mandate',
    );
    expect(mandate.merchant_id).toBe(merchantA.id);
    expect(mandate.customer_id).toBe(FIXTURE_CUSTOMER);
    expect(mandate.amount_ok).toBe(true);

    async function stored(id: string): Promise<StoredSubscription | undefined> {
      const rows = await db<StoredSubscription[]>`
        SELECT id, mandate_id, merchant_id, customer_id
          FROM subscriptions
         WHERE id = ${id}
      `;
      return rows[0];
    }

    async function constraints(): Promise<ConstraintRow[]> {
      return db<ConstraintRow[]>`
        SELECT con.conname, con.contype, pg_get_constraintdef(con.oid) AS def
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ${schema}
           AND con.conname IN (${MANDATE_PARTY_UQ}, ${SUBSCRIPTION_PARTY_FK})
         ORDER BY con.conname
      `;
    }

    async function mandateIdFk(): Promise<string | undefined> {
      const rows = await db<Array<{ def: string }>>`
        SELECT pg_get_constraintdef(con.oid) AS def
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ${schema}
           AND c.relname = 'subscriptions'
           AND con.contype = 'f'
           AND con.conname = ${MANDATE_ID_FK}
      `;
      return rows[0]?.def;
    }

    async function insertSubscription(merchantId: string, customerId: string): Promise<StoredSubscription> {
      return one(
        await db<StoredSubscription[]>`
          INSERT INTO subscriptions (mandate_id, merchant_id, customer_id, next_run_at)
          VALUES (${mandate.id}, ${merchantId}, ${customerId}, ${NEXT_RUN_AT})
          RETURNING id, mandate_id, merchant_id, customer_id
        `,
        'subscription',
      );
    }

    async function expectPartyRefused(merchantId: string, customerId: string): Promise<void> {
      const error = await db`
        INSERT INTO subscriptions (mandate_id, merchant_id, customer_id, next_run_at)
        VALUES (${mandate.id}, ${merchantId}, ${customerId}, ${NEXT_RUN_AT})
      `.then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).toMatchObject({ code: '23503' });
      expect(String((error as { message?: string }).message)).toContain(SUBSCRIPTION_PARTY_FK);
      const rows = await db<Array<{ n: string }>>`
        SELECT count(*)::text AS n
          FROM subscriptions
         WHERE mandate_id = ${mandate.id}
           AND merchant_id = ${merchantId}
           AND customer_id = ${customerId}
      `;
      expect(one(rows, 'refused subscription count').n).toBe('0');
    }

    expect(await mandateIdFk()).toBe('FOREIGN KEY (mandate_id) REFERENCES subscription_mandates(id)');
    expect(await constraints()).toEqual([]);

    const merchantMismatch = await insertSubscription(merchantB.id, FIXTURE_CUSTOMER);
    const customerMismatch = await insertSubscription(merchantA.id, OTHER_CUSTOMER);
    expect(merchantMismatch.mandate_id).toBe(mandate.id);
    expect(merchantMismatch.merchant_id).toBe(merchantB.id);
    expect(merchantMismatch.customer_id).toBe(FIXTURE_CUSTOMER);
    expect(customerMismatch.mandate_id).toBe(mandate.id);
    expect(customerMismatch.merchant_id).toBe(merchantA.id);
    expect(customerMismatch.customer_id).toBe(OTHER_CUSTOMER);

    const addError = await db.unsafe(closing).then(
      () => null,
      (err: unknown) => err,
    );
    expect(addError).toMatchObject({ code: '23503' });
    expect(String((addError as { message?: string }).message)).toContain(SUBSCRIPTION_PARTY_FK);
    expect(await stored(merchantMismatch.id)).toEqual(merchantMismatch);
    expect(await stored(customerMismatch.id)).toEqual(customerMismatch);
    expect(await constraints()).toEqual([]);
    expect(await mandateIdFk()).toBe('FOREIGN KEY (mandate_id) REFERENCES subscription_mandates(id)');

    await db`DELETE FROM subscriptions WHERE id IN (${merchantMismatch.id}, ${customerMismatch.id})`;

    await db.unsafe(closing);
    expect(await constraints()).toEqual([
      {
        conname: MANDATE_PARTY_UQ,
        contype: 'u',
        def: 'UNIQUE (id, merchant_id, customer_id)',
      },
      {
        conname: SUBSCRIPTION_PARTY_FK,
        contype: 'f',
        def: 'FOREIGN KEY (mandate_id, merchant_id, customer_id) REFERENCES subscription_mandates(id, merchant_id, customer_id)',
      },
    ]);
    expect(await mandateIdFk()).toBe('FOREIGN KEY (mandate_id) REFERENCES subscription_mandates(id)');

    await expectPartyRefused(merchantB.id, FIXTURE_CUSTOMER);
    await expectPartyRefused(merchantA.id, OTHER_CUSTOMER);
    await expectPartyRefused(merchantB.id, OTHER_CUSTOMER);

    const matched = await insertSubscription(merchantA.id, FIXTURE_CUSTOMER);
    expect(matched.mandate_id).toBe(mandate.id);
    expect(matched.merchant_id).toBe(mandate.merchant_id);
    expect(matched.customer_id).toBe(mandate.customer_id);

    const updateMerchant = await db`
      UPDATE subscriptions
         SET merchant_id = ${merchantB.id}
       WHERE id = ${matched.id}
    `.then(
      () => null,
      (err: unknown) => err,
    );
    expect(updateMerchant).toMatchObject({ code: '23503' });
    expect(String((updateMerchant as { message?: string }).message)).toContain(SUBSCRIPTION_PARTY_FK);

    const updateCustomer = await db`
      UPDATE subscriptions
         SET customer_id = ${OTHER_CUSTOMER}
       WHERE id = ${matched.id}
    `.then(
      () => null,
      (err: unknown) => err,
    );
    expect(updateCustomer).toMatchObject({ code: '23503' });
    expect(String((updateCustomer as { message?: string }).message)).toContain(SUBSCRIPTION_PARTY_FK);
    expect(await stored(matched.id)).toEqual(matched);

    await db.unsafe(closingDown);
    expect(await constraints()).toEqual([]);
    expect(await mandateIdFk()).toBe('FOREIGN KEY (mandate_id) REFERENCES subscription_mandates(id)');
    expect(await stored(matched.id)).toEqual(matched);
  });
});
