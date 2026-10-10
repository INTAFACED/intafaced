import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * subscription_mandates.amount is the authorised charge and ceiling is an
 * optional cap, both numeric(38,18). subscription_executions.amount is a
 * separate numeric(38,18) checked only with amount > 0. Nothing compares an
 * execution to the parent mandate, so a row can journal a charge above the
 * mandate amount and above the ceiling.
 *
 * 0032 adds a BEFORE INSERT OR UPDATE trigger on subscription_executions.
 * The function looks up the parent mandate through subscriptions.mandate_id.
 * NEW.amount greater than mandate.amount refuses. When mandate.ceiling is
 * not null and NEW.amount is greater than that ceiling, it refuses. An
 * amount equal to the mandate amount inserts. An amount equal to a non-null
 * ceiling inserts when that ceiling is also equal to the amount, which is
 * the only ceiling the existing CHECK ceiling >= amount allows. The refusal
 * is ERRCODE 23514. Stored rows are not rewritten. The amount > 0 check
 * stays. There is no NaN guard, no product magnitude, no ledger entry, and
 * no upsert. The down file drops the trigger and the function.
 *
 * Prior forward files are applied first, including 0031. Pay SQL is
 * schema-qualified and rewritten onto a schema in the database
 * TEST_DATABASE_URL names. This file does not start Postgres and does not
 * create a database.
 *
 * The fixture merchant, customer, asset, and amount strings live only in
 * this test. They are test fixtures, not product constants.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const CLOSING = '0032_pay_subscription_execution_within_mandate.sql';
const CLOSING_DOWN = '0032_pay_subscription_execution_within_mandate.down.sql';

const TRG = 'subscription_executions_within_mandate_trg';
const FN = 'subscription_executions_within_mandate';
const AMOUNT_CK = 'subscription_executions_amount_positive';

const FIXTURE_CUSTOMER = 'l877-fixture-customer';
const FIXTURE_ASSET = 'l877-fixture-asset';
/** Test fixtures, not product constants. */
const AMOUNT = '10';
const CEILING = '10';
const ABOVE_AMOUNT = '11';
const ABOVE_CEILING = '10.01';
const STARTS_AT = new Date('2026-01-15T00:00:00.000Z');
const NEXT_RUN_AT = new Date('2026-02-15T00:00:00.000Z');

const KEY_OPEN = 'l877-key-open';
const KEY_CAPPED = 'l877-key-capped';

const priorMigrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql') && f !== CLOSING)
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error('TEST_DATABASE_URL is unset; refusing to guess a database for an execution above its mandate');
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

interface StoredExecution {
  id: string;
  subscription_id: string;
  amount_ok: boolean;
}

describe('an execution amount cannot exceed the mandate amount or ceiling', () => {
  let sql: postgres.Sql | undefined;
  let admin: postgres.Sql | undefined;
  let schema = '';

  beforeAll(async () => {
    const url = testDatabaseUrl();
    admin = postgres(url, { max: 1, onnotice: () => undefined });
    const current = one(await admin<Array<{ db: string }>>`SELECT current_database() AS db`, 'current database');
    if (!current.db.endsWith('_test')) {
      throw new Error(`refusing to migrate an execution above its mandate on database ${current.db}`);
    }
    if (current.db === 'postgres') {
      throw new Error('refusing to migrate an execution above its mandate on database postgres');
    }

    schema = `test_pay_l877_${process.pid}`;
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

  it('refuses an execution above the mandate amount or ceiling and keeps an equal amount', async () => {
    const db = sql;
    if (!db || !schema) throw new Error('test database was not opened');

    const raw = readFileSync(join(drizzleDir, CLOSING), 'utf8');
    const rawDown = readFileSync(join(drizzleDir, CLOSING_DOWN), 'utf8');
    const closing = rewritePaySchema(raw, schema);
    const closingDown = rewritePaySchema(rawDown, schema);
    const statements = stripSqlComments(raw);
    const downStatements = stripSqlComments(rawDown);

    expect(statements).toContain('BEFORE INSERT OR UPDATE ON "pay"."subscription_executions"');
    expect(statements).toContain(`EXECUTE FUNCTION "pay"."${FN}"()`);
    expect(statements).toContain("ERRCODE = '23514'");
    expect(statements).toContain('FROM "pay"."subscriptions" AS s');
    expect(statements).toContain('JOIN "pay"."subscription_mandates" AS m');
    expect(statements).toContain('ON m.id = s.mandate_id');
    expect(statements).toContain('WHERE s.id = NEW.subscription_id');
    expect(statements).toContain('NEW.amount > mandate_amount');
    expect(statements).toContain('mandate_ceiling IS NOT NULL AND NEW.amount > mandate_ceiling');
    expect(statements).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(statements).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(statements).not.toMatch(/\bUPDATE\s+[\s\S]*\bSET\b/i);
    expect(statements).not.toMatch(/\bON\s+CONFLICT\b/i);
    expect(statements).not.toMatch(/\bledger\b/i);
    expect(statements).not.toMatch(/\bNaN\b/);
    expect(statements).not.toMatch(/\bfloat\b|\bdouble\b|\breal\b/i);
    expect(statements).not.toMatch(/\bDROP\s+CONSTRAINT\b/i);
    expect(statements).not.toContain(AMOUNT_CK);

    const dropTriggerAt = downStatements.indexOf(`DROP TRIGGER IF EXISTS "${TRG}"`);
    const dropFunctionAt = downStatements.indexOf(`DROP FUNCTION IF EXISTS "pay"."${FN}"()`);
    expect(dropTriggerAt).toBeGreaterThanOrEqual(0);
    expect(dropFunctionAt).toBeGreaterThan(dropTriggerAt);
    expect(downStatements).toContain(`ON "pay"."subscription_executions"`);
    expect(downStatements).not.toMatch(/\bINSERT\b/i);
    expect(downStatements).not.toMatch(/\bUPDATE\b/i);
    expect(downStatements).not.toMatch(/\bDELETE\b/i);
    expect(downStatements).not.toMatch(/\bON\s+CONFLICT\b/i);
    expect(downStatements).not.toContain(AMOUNT_CK);
    expect(closing).not.toContain('"pay"');
    expect(closing).toContain(`"${schema}"`);
    expect(closingDown).not.toContain('"pay"');

    async function amountCheck(): Promise<string> {
      const rows = await db<Array<{ def: string }>>`
        SELECT pg_get_constraintdef(con.oid) AS def
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ${schema}
           AND c.relname = 'subscription_executions'
           AND con.conname = ${AMOUNT_CK}
      `;
      return one(rows, 'execution amount check').def;
    }

    async function triggerDef(): Promise<string | undefined> {
      const rows = await db<Array<{ def: string }>>`
        SELECT pg_get_triggerdef(t.oid) AS def
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ${schema}
           AND c.relname = 'subscription_executions'
           AND t.tgname = ${TRG}
           AND NOT t.tgisinternal
      `;
      return rows[0]?.def;
    }

    async function functionNames(): Promise<string[]> {
      const rows = await db<Array<{ proname: string }>>`
        SELECT p.proname
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = ${schema}
           AND p.proname = ${FN}
      `;
      return rows.map((row) => row.proname);
    }

    async function amountEquals(id: string, expected: string): Promise<boolean> {
      const rows = await db<Array<{ ok: boolean }>>`
        SELECT (amount = ${expected}::numeric) AS ok
          FROM subscription_executions
         WHERE id = ${id}
      `;
      return one(rows, 'execution amount').ok;
    }

    async function expectCheckRefused(run: () => Promise<unknown>): Promise<void> {
      const error = await run().then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).toMatchObject({ code: '23514' });
      expect(String((error as { message?: string }).message)).toContain(FN);
    }

    const merchant = one(
      await db<Array<{ id: string }>>`
        INSERT INTO merchants (user_id)
        VALUES ('l877-merchant')
        RETURNING id
      `,
      'merchant',
    );

    async function insertMandate(ceiling: string | null): Promise<{ id: string; merchant_id: string; customer_id: string }> {
      if (ceiling === null) {
        return one(
          await db<Array<{ id: string; merchant_id: string; customer_id: string }>>`
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
            RETURNING id, merchant_id, customer_id
          `,
          'open mandate',
        );
      }
      return one(
        await db<Array<{ id: string; merchant_id: string; customer_id: string }>>`
          INSERT INTO subscription_mandates (
            merchant_id, customer_id, asset_id, amount, ceiling, cadence, starts_at
          ) VALUES (
            ${merchant.id},
            ${FIXTURE_CUSTOMER},
            ${FIXTURE_ASSET},
            ${AMOUNT}::numeric,
            ${ceiling}::numeric,
            'monthly',
            ${STARTS_AT}
          )
          RETURNING id, merchant_id, customer_id
        `,
        'capped mandate',
      );
    }

    async function insertSubscription(mandateId: string, merchantId: string, customerId: string, key: string): Promise<string> {
      const row = one(
        await db<Array<{ id: string }>>`
          INSERT INTO subscriptions (
            mandate_id, merchant_id, customer_id, next_run_at, idempotency_key
          ) VALUES (
            ${mandateId},
            ${merchantId},
            ${customerId},
            ${NEXT_RUN_AT},
            ${key}
          )
          RETURNING id
        `,
        'subscription',
      );
      return row.id;
    }

    async function insertExecution(subscriptionId: string, occurrence: number, amount: string): Promise<StoredExecution> {
      return one(
        await db<StoredExecution[]>`
          INSERT INTO subscription_executions (subscription_id, occurrence, amount)
          VALUES (${subscriptionId}, ${occurrence}, ${amount}::numeric)
          RETURNING id, subscription_id, (amount = ${amount}::numeric) AS amount_ok
        `,
        'execution',
      );
    }

    const openMandate = await insertMandate(null);
    const cappedMandate = await insertMandate(CEILING);
    const openCeiling = one(
      await db<Array<{ ceiling_null: boolean; amount_ok: boolean }>>`
        SELECT (ceiling IS NULL) AS ceiling_null, (amount = ${AMOUNT}::numeric) AS amount_ok
          FROM subscription_mandates
         WHERE id = ${openMandate.id}
      `,
      'open mandate bounds',
    );
    const cappedCeiling = one(
      await db<Array<{ ceiling_ok: boolean; amount_ok: boolean }>>`
        SELECT (ceiling = ${CEILING}::numeric) AS ceiling_ok, (amount = ${AMOUNT}::numeric) AS amount_ok
          FROM subscription_mandates
         WHERE id = ${cappedMandate.id}
      `,
      'capped mandate bounds',
    );
    expect(openCeiling).toEqual({ ceiling_null: true, amount_ok: true });
    expect(cappedCeiling).toEqual({ ceiling_ok: true, amount_ok: true });

    const openSub = await insertSubscription(openMandate.id, openMandate.merchant_id, openMandate.customer_id, KEY_OPEN);
    const cappedSub = await insertSubscription(
      cappedMandate.id,
      cappedMandate.merchant_id,
      cappedMandate.customer_id,
      KEY_CAPPED,
    );

    const amountCheckBefore = await amountCheck();
    expect(amountCheckBefore).toMatch(/amount > \(?0\)?/);
    expect(await triggerDef()).toBeUndefined();
    expect(await functionNames()).toEqual([]);

    const hole = await insertExecution(openSub, 0, ABOVE_AMOUNT);
    expect(hole.subscription_id).toBe(openSub);
    expect(hole.amount_ok).toBe(true);
    expect(await amountEquals(hole.id, ABOVE_AMOUNT)).toBe(true);

    await db.unsafe(closing);
    expect(await amountEquals(hole.id, ABOVE_AMOUNT)).toBe(true);
    expect(await functionNames()).toEqual([FN]);
    const installed = await triggerDef();
    expect(installed).toMatch(/BEFORE INSERT OR UPDATE ON/);
    expect(installed).toContain(TRG);
    expect(installed).toContain(FN);
    expect(await amountCheck()).toBe(amountCheckBefore);

    const equalOpen = await insertExecution(openSub, 1, AMOUNT);
    expect(equalOpen.subscription_id).toBe(openSub);
    expect(equalOpen.amount_ok).toBe(true);
    expect(await amountEquals(equalOpen.id, AMOUNT)).toBe(true);

    await expectCheckRefused(() => insertExecution(openSub, 2, ABOVE_AMOUNT));
    const aboveOpen = await db<Array<{ n: string }>>`
      SELECT count(*)::text AS n
        FROM subscription_executions
       WHERE subscription_id = ${openSub}
         AND occurrence = 2
    `;
    expect(one(aboveOpen, 'refused open execution count').n).toBe('0');
    expect(await amountEquals(equalOpen.id, AMOUNT)).toBe(true);

    const equalCapped = await insertExecution(cappedSub, 0, AMOUNT);
    expect(equalCapped.subscription_id).toBe(cappedSub);
    expect(equalCapped.amount_ok).toBe(true);
    expect(await amountEquals(equalCapped.id, AMOUNT)).toBe(true);
    expect(await amountEquals(equalCapped.id, CEILING)).toBe(true);

    await expectCheckRefused(() => insertExecution(cappedSub, 1, ABOVE_CEILING));
    const aboveCapped = await db<Array<{ n: string }>>`
      SELECT count(*)::text AS n
        FROM subscription_executions
       WHERE subscription_id = ${cappedSub}
         AND occurrence = 1
    `;
    expect(one(aboveCapped, 'refused capped execution count').n).toBe('0');
    expect(await amountEquals(equalCapped.id, AMOUNT)).toBe(true);

    await expectCheckRefused(
      () => db`
        UPDATE subscription_executions
           SET amount = ${ABOVE_AMOUNT}::numeric
         WHERE id = ${equalOpen.id}
      `,
    );
    expect(await amountEquals(equalOpen.id, AMOUNT)).toBe(true);
    expect(await amountEquals(hole.id, ABOVE_AMOUNT)).toBe(true);
    expect(await amountEquals(equalCapped.id, AMOUNT)).toBe(true);

    await db.unsafe(closingDown);
    expect(await triggerDef()).toBeUndefined();
    expect(await functionNames()).toEqual([]);
    expect(await amountCheck()).toBe(amountCheckBefore);
    expect(await amountEquals(equalOpen.id, AMOUNT)).toBe(true);
    expect(await amountEquals(hole.id, ABOVE_AMOUNT)).toBe(true);

    const afterDown = await insertExecution(openSub, 2, ABOVE_AMOUNT);
    expect(afterDown.subscription_id).toBe(openSub);
    expect(afterDown.amount_ok).toBe(true);
    expect(await amountEquals(afterDown.id, ABOVE_AMOUNT)).toBe(true);
    expect(await amountEquals(equalOpen.id, AMOUNT)).toBe(true);
  });
});
