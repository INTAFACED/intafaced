import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * subscriptions.mandate_id is a reference, not a limit. 0010 allows many
 * subscription rows for one mandate. The double-fire guard is only
 * unique (subscription_id, occurrence) on executions, so two active rows
 * can each settle occurrence N. subscriptions has no idempotency key, so a
 * retried create inserts a second schedule instead of refusing.
 *
 * 0041 adds idempotency_key text NOT NULL, CHECK (length(btrim(key)) > 0),
 * and UNIQUE (idempotency_key). It adds a partial unique index on mandate_id
 * WHERE status = 'active'. A cancelled or paused row may sit beside one
 * active row. Two active rows for one mandate refuse. Two inserts of the
 * same key refuse. There is no upsert. No default and no backfill: if a
 * stored row exists, ADD COLUMN fails and that row stays. The migration
 * does not invent a customer, a merchant, or an amount, and it does not
 * move value. The execution unique stays.
 *
 * Prior forward files are applied first, including 0030. Pay SQL is
 * schema-qualified and rewritten onto a schema in the database
 * TEST_DATABASE_URL names. This file does not start Postgres and does not
 * create a database.
 *
 * The fixture merchant, customer, and asset live only in this test. The
 * amount is the positive string already used by charge-cycle.db.test.ts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const CLOSING = '0041_pay_subscription_one_active.sql';
const CLOSING_DOWN = '0041_pay_subscription_one_active.down.sql';

const KEY_CK = 'subscriptions_idempotency_key_not_blank';
const KEY_UQ = 'subscriptions_idempotency_key_uq';
const ACTIVE_IDX = 'subscriptions_one_active_mandate_idx';
const OCCURRENCE_IDX = 'subscription_executions_occurrence_idx';

const FIXTURE_CUSTOMER = 'l876-fixture-customer';
const FIXTURE_ASSET = 'l876-fixture-asset';
/** Positive amount string already used by charge-cycle.db.test.ts. */
const AMOUNT = '10';
const STARTS_AT = new Date('2026-01-15T00:00:00.000Z');
const NEXT_RUN_AT = new Date('2026-02-15T00:00:00.000Z');

const KEY_ACTIVE = 'l876-key-active';
const KEY_SECOND = 'l876-key-second-active';
const KEY_CANCELLED = 'l876-key-cancelled';
const KEY_PAUSED = 'l876-key-paused';
const KEY_OTHER = 'l876-key-other-mandate';

const priorMigrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql') && f !== CLOSING)
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error('TEST_DATABASE_URL is unset; refusing to guess a database for one active subscription');
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
  status: string;
  idempotency_key: string;
}

interface BareSubscription {
  id: string;
  mandate_id: string;
  status: string;
}

interface ConstraintRow {
  conname: string;
  contype: string;
  def: string;
}

describe('one mandate has one active subscription and one idempotency key', () => {
  let sql: postgres.Sql | undefined;
  let admin: postgres.Sql | undefined;
  let schema = '';

  beforeAll(async () => {
    const url = testDatabaseUrl();
    admin = postgres(url, { max: 1, onnotice: () => undefined });
    const current = one(await admin<Array<{ db: string }>>`SELECT current_database() AS db`, 'current database');
    if (!current.db.endsWith('_test')) {
      throw new Error(`refusing to migrate one active subscription on database ${current.db}`);
    }
    if (current.db === 'postgres') {
      throw new Error('refusing to migrate one active subscription on database postgres');
    }

    schema = `test_pay_l876_${process.pid}`;
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

  it('refuses a second active subscription and a repeated idempotency key, and keeps one active beside a cancelled row', async () => {
    const db = sql;
    if (!db || !schema) throw new Error('test database was not opened');

    const raw = readFileSync(join(drizzleDir, CLOSING), 'utf8');
    const rawDown = readFileSync(join(drizzleDir, CLOSING_DOWN), 'utf8');
    const closing = rewritePaySchema(raw, schema);
    const closingDown = rewritePaySchema(rawDown, schema);
    const statements = stripSqlComments(raw);
    const downStatements = stripSqlComments(rawDown);

    const columnAt = statements.indexOf('"idempotency_key" text NOT NULL');
    const uniqueAt = statements.indexOf(KEY_UQ);
    const indexAt = statements.indexOf(ACTIVE_IDX);
    expect(columnAt).toBeGreaterThanOrEqual(0);
    expect(uniqueAt).toBeGreaterThan(columnAt);
    expect(indexAt).toBeGreaterThan(uniqueAt);
    expect(statements).toMatch(
      new RegExp(
        `ADD COLUMN "idempotency_key" text NOT NULL\\s+CONSTRAINT "${KEY_CK}"\\s+CHECK \\(length\\(btrim\\("idempotency_key"\\)\\) > 0\\)`,
      ),
    );
    expect(statements).toMatch(
      new RegExp(`ADD CONSTRAINT "${KEY_UQ}"\\s+UNIQUE \\("idempotency_key"\\)`),
    );
    expect(statements).toMatch(
      new RegExp(
        `CREATE UNIQUE INDEX "${ACTIVE_IDX}"\\s+ON "pay"\\."subscriptions" \\("mandate_id"\\)\\s+WHERE "status" = 'active'`,
      ),
    );
    expect(statements).toContain('"pay"."subscriptions"');
    expect(statements).not.toMatch(/\bDROP\b/i);
    expect(statements).not.toMatch(/\bINSERT\b/i);
    expect(statements).not.toMatch(/\bUPDATE\b/i);
    expect(statements).not.toMatch(/\bDELETE\b/i);
    expect(statements).not.toMatch(/\bTRIGGER\b/i);
    expect(statements).not.toMatch(/\bON\s+CONFLICT\b/i);
    expect(statements).not.toMatch(/\bDEFAULT\b/i);
    expect(statements).not.toMatch(/\bamount\b/i);
    expect(statements).not.toMatch(/subscription_executions/);
    expect(statements).not.toContain(OCCURRENCE_IDX);

    const dropIndexAt = downStatements.indexOf(ACTIVE_IDX);
    const dropUniqueAt = downStatements.indexOf(KEY_UQ);
    const dropCheckAt = downStatements.indexOf(KEY_CK);
    const dropColumnAt = downStatements.indexOf('DROP COLUMN IF EXISTS "idempotency_key"');
    expect(dropIndexAt).toBeGreaterThanOrEqual(0);
    expect(dropUniqueAt).toBeGreaterThan(dropIndexAt);
    expect(dropCheckAt).toBeGreaterThan(dropUniqueAt);
    expect(dropColumnAt).toBeGreaterThan(dropCheckAt);
    expect(downStatements).toContain(`DROP INDEX IF EXISTS "pay"."${ACTIVE_IDX}"`);
    expect(downStatements).toContain(`DROP CONSTRAINT IF EXISTS "${KEY_UQ}"`);
    expect(downStatements).toContain(`DROP CONSTRAINT IF EXISTS "${KEY_CK}"`);
    expect(downStatements).not.toMatch(/\bINSERT\b/i);
    expect(downStatements).not.toMatch(/\bUPDATE\b/i);
    expect(downStatements).not.toMatch(/\bDELETE\b/i);
    expect(downStatements).not.toMatch(/\bTRIGGER\b/i);
    expect(downStatements).not.toMatch(/\bON\s+CONFLICT\b/i);
    expect(downStatements).not.toMatch(/subscription_executions/);
    expect(downStatements).not.toContain(OCCURRENCE_IDX);
    expect(closing).not.toContain('"pay"');
    expect(closing).toContain(`"${schema}"`);
    expect(closingDown).not.toContain('"pay"');

    const merchant = one(
      await db<Array<{ id: string }>>`
        INSERT INTO merchants (user_id)
        VALUES ('l876-merchant')
        RETURNING id
      `,
      'merchant',
    );

    async function insertMandate(): Promise<{ id: string; merchant_id: string; customer_id: string; amount_ok: boolean }> {
      return one(
        await db<Array<{ id: string; merchant_id: string; customer_id: string; amount_ok: boolean }>>`
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
          RETURNING id, merchant_id, customer_id, (amount = ${AMOUNT}::numeric) AS amount_ok
        `,
        'mandate',
      );
    }

    const mandate = await insertMandate();
    const otherMandate = await insertMandate();
    expect(mandate.merchant_id).toBe(merchant.id);
    expect(mandate.customer_id).toBe(FIXTURE_CUSTOMER);
    expect(mandate.amount_ok).toBe(true);
    expect(otherMandate.amount_ok).toBe(true);
    expect(otherMandate.id).not.toBe(mandate.id);

    async function columnPresent(): Promise<string> {
      const rows = await db<Array<{ n: string }>>`
        SELECT count(*)::text AS n
          FROM information_schema.columns
         WHERE table_schema = ${schema}
           AND table_name = 'subscriptions'
           AND column_name = 'idempotency_key'
      `;
      return one(rows, 'idempotency_key column count').n;
    }

    async function constraints(): Promise<ConstraintRow[]> {
      return db<ConstraintRow[]>`
        SELECT con.conname, con.contype, pg_get_constraintdef(con.oid) AS def
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ${schema}
           AND con.conname IN (${KEY_CK}, ${KEY_UQ})
         ORDER BY con.conname
      `;
    }

    async function partialIndex(): Promise<Array<{ is_unique: boolean; pred: string | null }>> {
      return db<Array<{ is_unique: boolean; pred: string | null }>>`
        SELECT i.indisunique AS is_unique, pg_get_expr(i.indpred, i.indrelid) AS pred
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ${schema}
           AND c.relname = ${ACTIVE_IDX}
      `;
    }

    async function partialColumns(): Promise<string[]> {
      const rows = await db<Array<{ attname: string }>>`
        SELECT a.attname
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          JOIN pg_class t ON t.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
         WHERE n.nspname = ${schema}
           AND c.relname = ${ACTIVE_IDX}
         ORDER BY k.ord
      `;
      return rows.map((row) => row.attname);
    }

    async function occurrenceIndex(): Promise<string> {
      const rows = await db<Array<{ def: string }>>`
        SELECT pg_get_indexdef(i.indexrelid) AS def
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          JOIN pg_class t ON t.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = ${schema}
           AND t.relname = 'subscription_executions'
           AND c.relname = ${OCCURRENCE_IDX}
           AND i.indisunique
      `;
      return one(rows, 'occurrence unique index').def;
    }

    async function bare(id: string): Promise<BareSubscription | undefined> {
      const rows = await db<BareSubscription[]>`
        SELECT id, mandate_id, status::text AS status
          FROM subscriptions
         WHERE id = ${id}
      `;
      return rows[0];
    }

    async function stored(id: string): Promise<StoredSubscription | undefined> {
      const rows = await db<StoredSubscription[]>`
        SELECT id, mandate_id, merchant_id, customer_id, status::text AS status, idempotency_key
          FROM subscriptions
         WHERE id = ${id}
      `;
      return rows[0];
    }

    async function countKey(key: string): Promise<string> {
      const rows = await db<Array<{ n: string }>>`
        SELECT count(*)::text AS n
          FROM subscriptions
         WHERE idempotency_key = ${key}
      `;
      return one(rows, 'idempotency key count').n;
    }

    async function insertBare(mandateId: string): Promise<BareSubscription> {
      return one(
        await db<BareSubscription[]>`
          INSERT INTO subscriptions (mandate_id, merchant_id, customer_id, next_run_at)
          VALUES (${mandateId}, ${mandate.merchant_id}, ${mandate.customer_id}, ${NEXT_RUN_AT})
          RETURNING id, mandate_id, status::text AS status
        `,
        'bare subscription',
      );
    }

    async function insertSubscription(
      mandateId: string,
      key: string,
      status: string,
    ): Promise<StoredSubscription> {
      return one(
        await db<StoredSubscription[]>`
          INSERT INTO subscriptions (
            mandate_id, merchant_id, customer_id, next_run_at, status, idempotency_key
          ) VALUES (
            ${mandateId},
            ${mandate.merchant_id},
            ${mandate.customer_id},
            ${NEXT_RUN_AT},
            ${status}::subscription_status,
            ${key}
          )
          RETURNING id, mandate_id, merchant_id, customer_id, status::text AS status, idempotency_key
        `,
        'subscription',
      );
    }

    async function expectUniqueRefused(run: () => Promise<unknown>, constraint: string): Promise<void> {
      const error = await run().then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).toMatchObject({ code: '23505' });
      expect(String((error as { message?: string }).message)).toContain(constraint);
    }

    const occurrenceBefore = await occurrenceIndex();
    expect(occurrenceBefore).toContain('(subscription_id, occurrence)');
    expect(await columnPresent()).toBe('0');
    expect(await constraints()).toEqual([]);
    expect(await partialIndex()).toEqual([]);

    const firstBare = await insertBare(mandate.id);
    const secondBare = await insertBare(mandate.id);
    expect(firstBare.mandate_id).toBe(mandate.id);
    expect(firstBare.status).toBe('active');
    expect(secondBare.mandate_id).toBe(mandate.id);
    expect(secondBare.status).toBe('active');
    expect(secondBare.id).not.toBe(firstBare.id);

    const addError = await db.unsafe(closing).then(
      () => null,
      (err: unknown) => err,
    );
    expect(addError).toMatchObject({ code: '23502' });
    expect(String((addError as { message?: string }).message)).toContain('idempotency_key');
    expect(await bare(firstBare.id)).toEqual(firstBare);
    expect(await bare(secondBare.id)).toEqual(secondBare);
    expect(await columnPresent()).toBe('0');
    expect(await constraints()).toEqual([]);
    expect(await partialIndex()).toEqual([]);
    expect(await occurrenceIndex()).toBe(occurrenceBefore);

    await db`DELETE FROM subscriptions WHERE id IN (${firstBare.id}, ${secondBare.id})`;
    const emptied = await db<Array<{ n: string }>>`SELECT count(*)::text AS n FROM subscriptions`;
    expect(one(emptied, 'subscription count before 0031').n).toBe('0');

    await db.unsafe(closing);
    expect(await columnPresent()).toBe('1');
    expect(await constraints()).toEqual([
      {
        conname: KEY_CK,
        contype: 'c',
        def: 'CHECK ((length(btrim(idempotency_key)) > 0))',
      },
      {
        conname: KEY_UQ,
        contype: 'u',
        def: 'UNIQUE (idempotency_key)',
      },
    ]);
    const partial = one(await partialIndex(), 'partial unique index');
    expect(partial.is_unique).toBe(true);
    expect(partial.pred).toMatch(/status = 'active'::.*subscription_status/);
    expect(await partialColumns()).toEqual(['mandate_id']);
    expect(await occurrenceIndex()).toBe(occurrenceBefore);

    const nullable = one(
      await db<Array<{ is_nullable: string; data_type: string }>>`
        SELECT is_nullable, data_type
          FROM information_schema.columns
         WHERE table_schema = ${schema}
           AND table_name = 'subscriptions'
           AND column_name = 'idempotency_key'
      `,
      'idempotency_key column',
    );
    expect(nullable).toEqual({ is_nullable: 'NO', data_type: 'text' });

    const active = await insertSubscription(mandate.id, KEY_ACTIVE, 'active');
    expect(active.mandate_id).toBe(mandate.id);
    expect(active.merchant_id).toBe(mandate.merchant_id);
    expect(active.customer_id).toBe(mandate.customer_id);
    expect(active.status).toBe('active');
    expect(active.idempotency_key).toBe(KEY_ACTIVE);

    await expectUniqueRefused(
      () => db`
        INSERT INTO subscriptions (
          mandate_id, merchant_id, customer_id, next_run_at, status, idempotency_key
        ) VALUES (
          ${mandate.id},
          ${mandate.merchant_id},
          ${mandate.customer_id},
          ${NEXT_RUN_AT},
          'active'::subscription_status,
          ${KEY_SECOND}
        )
      `,
      ACTIVE_IDX,
    );
    expect(await countKey(KEY_SECOND)).toBe('0');

    await expectUniqueRefused(
      () => db`
        INSERT INTO subscriptions (
          mandate_id, merchant_id, customer_id, next_run_at, status, idempotency_key
        ) VALUES (
          ${otherMandate.id},
          ${otherMandate.merchant_id},
          ${otherMandate.customer_id},
          ${NEXT_RUN_AT},
          'active'::subscription_status,
          ${KEY_ACTIVE}
        )
      `,
      KEY_UQ,
    );

    const cancelled = await insertSubscription(mandate.id, KEY_CANCELLED, 'cancelled');
    expect(cancelled.mandate_id).toBe(mandate.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.idempotency_key).toBe(KEY_CANCELLED);
    expect(await stored(active.id)).toEqual(active);

    const paused = await insertSubscription(mandate.id, KEY_PAUSED, 'paused');
    expect(paused.mandate_id).toBe(mandate.id);
    expect(paused.status).toBe('paused');
    expect(await stored(active.id)).toEqual(active);

    const promote = await db`
      UPDATE subscriptions
         SET status = 'active'::subscription_status
       WHERE id = ${cancelled.id}
    `.then(
      () => null,
      (err: unknown) => err,
    );
    expect(promote).toMatchObject({ code: '23505' });
    expect(String((promote as { message?: string }).message)).toContain(ACTIVE_IDX);
    expect(await stored(cancelled.id)).toEqual(cancelled);
    expect(await stored(active.id)).toEqual(active);

    const blank = await db`
      INSERT INTO subscriptions (
        mandate_id, merchant_id, customer_id, next_run_at, idempotency_key
      ) VALUES (
        ${otherMandate.id},
        ${otherMandate.merchant_id},
        ${otherMandate.customer_id},
        ${NEXT_RUN_AT},
        '   '
      )
    `.then(
      () => null,
      (err: unknown) => err,
    );
    expect(blank).toMatchObject({ code: '23514' });
    expect(String((blank as { message?: string }).message)).toContain(KEY_CK);

    const missing = await db`
      INSERT INTO subscriptions (mandate_id, merchant_id, customer_id, next_run_at)
      VALUES (
        ${otherMandate.id},
        ${otherMandate.merchant_id},
        ${otherMandate.customer_id},
        ${NEXT_RUN_AT}
      )
    `.then(
      () => null,
      (err: unknown) => err,
    );
    expect(missing).toMatchObject({ code: '23502' });
    expect(String((missing as { message?: string }).message)).toContain('idempotency_key');

    const otherActive = await insertSubscription(otherMandate.id, KEY_OTHER, 'active');
    expect(otherActive.mandate_id).toBe(otherMandate.id);
    expect(otherActive.status).toBe('active');
    expect(otherActive.idempotency_key).toBe(KEY_OTHER);

    const executions = await db<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM subscription_executions
    `;
    expect(one(executions, 'execution count').n).toBe('0');
    expect(await occurrenceIndex()).toBe(occurrenceBefore);

    const amountStill = await db<Array<{ amount_ok: boolean }>>`
      SELECT (amount = ${AMOUNT}::numeric) AS amount_ok
        FROM subscription_mandates
       WHERE id = ${mandate.id}
    `;
    expect(one(amountStill, 'mandate amount').amount_ok).toBe(true);

    await db.unsafe(closingDown);
    expect(await columnPresent()).toBe('0');
    expect(await constraints()).toEqual([]);
    expect(await partialIndex()).toEqual([]);
    expect(await occurrenceIndex()).toBe(occurrenceBefore);
    expect(await bare(active.id)).toEqual({
      id: active.id,
      mandate_id: active.mandate_id,
      status: active.status,
    });
    expect(await bare(cancelled.id)).toEqual({
      id: cancelled.id,
      mandate_id: cancelled.mandate_id,
      status: cancelled.status,
    });
    expect(await bare(paused.id)).toEqual({
      id: paused.id,
      mandate_id: paused.mandate_id,
      status: paused.status,
    });

    const secondAfterDown = await insertBare(mandate.id);
    expect(secondAfterDown.mandate_id).toBe(mandate.id);
    expect(secondAfterDown.status).toBe('active');
    expect(secondAfterDown.id).not.toBe(active.id);
    expect(await occurrenceIndex()).toBe(occurrenceBefore);
  });
});
