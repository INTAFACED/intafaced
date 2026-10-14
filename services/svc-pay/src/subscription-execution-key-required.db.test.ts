import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * subscription_executions.idempotency_key is nullable in 0011, and the unique
 * index ignores nulls. One period, one key, one row holds only when every
 * writer sets the key. Any number of rows can omit it. last_attempt_at is
 * added null. subscription_executions_retry_idx is (status, last_attempt_at)
 * WHERE exhausted_at IS NULL, so a cutoff on last_attempt_at skips every row
 * that left the column null.
 *
 * 0042 makes idempotency_key NOT NULL with CHECK (length(btrim(key)) > 0),
 * drops the partial unique index, and adds a non-partial UNIQUE (idempotency_key).
 * No default and no invented key. A stored null fails SET NOT NULL and stays.
 * A stored blank fails the check and stays. last_attempt_at gets DEFAULT now(),
 * then SET NOT NULL. Stored rows are not updated to a timestamp. A stored null
 * fails SET NOT NULL and stays. A new insert that omits last_attempt_at stores
 * a non-null timestamptz. The retry index stays. A blank or space-only key
 * refuses 23514. A missing key refuses 23502. The same key on a second row
 * refuses 23505. Two different non-blank keys insert. The down file drops the
 * new not-null, check, full unique, and the last_attempt_at default, and
 * restores the partial unique index. It does not drop the columns.
 *
 * Prior forward files are applied first, including 0033. Pay SQL is
 * schema-qualified and rewritten onto a schema in the database
 * TEST_DATABASE_URL names. This file does not start Postgres and does not
 * create a database.
 *
 * The fixture merchant, customer, asset, and keys live only in this test.
 * The amount is the decimal string '10' only. There is no ledger post.
 * Money stays numeric.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const CLOSING = '0042_pay_subscription_execution_key_required.sql';
const CLOSING_DOWN = '0042_pay_subscription_execution_key_required.down.sql';

const KEY_CK = 'subscription_executions_idempotency_key_not_blank';
const KEY_UQ = 'subscription_executions_idempotency_key_uq';
const PARTIAL_IDX = 'subscription_executions_idempotency_key_idx';
const RETRY_IDX = 'subscription_executions_retry_idx';
const OCCURRENCE_IDX = 'subscription_executions_occurrence_idx';
const SUB_KEY_CK = 'subscriptions_idempotency_key_not_blank';
const SUB_KEY_UQ = 'subscriptions_idempotency_key_uq';

const FIXTURE_CUSTOMER = 'l879-fixture-customer';
const FIXTURE_ASSET = 'l879-fixture-asset';
/** Decimal string. The only amount in this test. Not a product magnitude. */
const AMOUNT = '10';
const STARTS_AT = new Date('2026-01-15T00:00:00.000Z');
const NEXT_RUN_AT = new Date('2026-02-15T00:00:00.000Z');
const ATTEMPT_AT = new Date('2026-03-01T00:00:00.000Z');

const SUBSCRIPTION_KEY = 'l879-subscription-key';
const KEY_A = 'l879-key-a';
const KEY_B = 'l879-key-b';
const KEY_C = 'l879-key-c';
const KEY_D = 'l879-key-d';
const SPACES = '   ';

const priorMigrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql') && f !== CLOSING)
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error('TEST_DATABASE_URL is unset; refusing to guess a database for an execution key');
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
  occurrence: number;
  status: string;
  idempotency_key: string | null;
  last_attempt_at: Date | null;
  amount_ok: boolean;
  ledger_tx_id: string | null;
}

interface ColumnFact {
  is_nullable: string;
  column_default: string | null;
  data_type: string;
}

interface IndexFact {
  oid: string;
  is_unique: boolean;
  pred: string | null;
  def: string;
}

interface ConstraintFact {
  oid: string;
  conname: string;
  contype: string;
  def: string;
}

describe('an execution key is required and last_attempt_at is not null', () => {
  let sql: postgres.Sql | undefined;
  let admin: postgres.Sql | undefined;
  let schema = '';

  beforeAll(async () => {
    const url = testDatabaseUrl();
    admin = postgres(url, { max: 1, onnotice: () => undefined });
    const current = one(await admin<Array<{ db: string }>>`SELECT current_database() AS db`, 'current database');
    if (current.db === 'postgres') {
      throw new Error('refusing to migrate an execution key on database postgres');
    }
    if (!current.db.endsWith('_test')) {
      throw new Error(`refusing to migrate an execution key on database ${current.db}`);
    }

    schema = `test_pay_l879_${process.pid}`;
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

  it('requires a non-blank execution key and a non-null last_attempt_at, and restores the partial index on the way down', async () => {
    if (!sql || !schema) throw new Error('test database was not opened');
    const db = sql;

    const raw = readFileSync(join(drizzleDir, CLOSING), 'utf8');
    const rawDown = readFileSync(join(drizzleDir, CLOSING_DOWN), 'utf8');
    const closing = rewritePaySchema(raw, schema);
    const closingDown = rewritePaySchema(rawDown, schema);
    const statements = stripSqlComments(raw);
    const downStatements = stripSqlComments(rawDown);

    expect(raw).toMatch(/intafaced:destructive/);
    expect(rawDown).toMatch(/intafaced:destructive/);

    const defaultAt = statements.indexOf('ALTER COLUMN "last_attempt_at" SET DEFAULT now()');
    const lastNotNullAt = statements.indexOf('ALTER COLUMN "last_attempt_at" SET NOT NULL');
    const keyNotNullAt = statements.indexOf('ALTER COLUMN "idempotency_key" SET NOT NULL');
    const checkAt = statements.indexOf(`"${KEY_CK}"`);
    const dropAt = statements.indexOf(`DROP INDEX "pay"."${PARTIAL_IDX}"`);
    const uniqueAt = statements.indexOf(`ADD CONSTRAINT "${KEY_UQ}"`);
    expect(defaultAt).toBeGreaterThanOrEqual(0);
    expect(lastNotNullAt).toBeGreaterThan(defaultAt);
    expect(keyNotNullAt).toBeGreaterThan(lastNotNullAt);
    expect(checkAt).toBeGreaterThan(keyNotNullAt);
    expect(dropAt).toBeGreaterThan(checkAt);
    expect(uniqueAt).toBeGreaterThan(dropAt);
    expect(statements.slice(0, keyNotNullAt)).not.toMatch(/idempotency_key/);
    expect(statements.slice(keyNotNullAt)).not.toMatch(/\bDEFAULT\b/);
    expect(statements).toMatch(
      new RegExp(
        `ADD CONSTRAINT "${KEY_CK}"\\s+CHECK \\(length\\(btrim\\("idempotency_key"\\)\\) > 0\\)`,
      ),
    );
    expect(statements).toMatch(
      new RegExp(`ADD CONSTRAINT "${KEY_UQ}"\\s+UNIQUE \\("idempotency_key"\\)`),
    );
    expect(statements.match(/ALTER TABLE/g)).toHaveLength(5);
    expect(statements.match(/SET NOT NULL/g)).toHaveLength(2);
    expect(statements.match(/SET DEFAULT/g)).toHaveLength(1);
    expect(statements.match(/DROP INDEX/g)).toHaveLength(1);
    expect(statements.match(/ADD CONSTRAINT/g)).toHaveLength(2);
    expect(statements).not.toMatch(/\bUPDATE\b|\bINSERT\b|\bDELETE\b|\bDROP\s+COLUMN\b|\bDROP\s+CONSTRAINT\b/i);
    expect(statements).not.toMatch(/\bsubscriptions\b/);
    expect(statements).not.toContain(RETRY_IDX);
    expect(statements).not.toContain(OCCURRENCE_IDX);
    expect(statements).not.toMatch(/\bNULLS\s+NOT\s+DISTINCT\b/i);
    expect(statements).not.toMatch(/\bIF\s+(?:NOT\s+)?EXISTS\b/i);
    expect(statements).not.toMatch(/\bfloat\b|\bdouble\b|\breal\b|\bamount\b|\bledger\b/i);
    expect(statements).toContain('"pay"."subscription_executions"');
    expect(closing).not.toContain('"pay"');
    expect(closing).toContain(`"${schema}"`);

    const dropUq = downStatements.indexOf(`DROP CONSTRAINT IF EXISTS "${KEY_UQ}"`);
    const dropCk = downStatements.indexOf(`DROP CONSTRAINT IF EXISTS "${KEY_CK}"`);
    const dropKeyNull = downStatements.indexOf('ALTER COLUMN "idempotency_key" DROP NOT NULL');
    const dropLastNull = downStatements.indexOf('ALTER COLUMN "last_attempt_at" DROP NOT NULL');
    const dropDefault = downStatements.indexOf('ALTER COLUMN "last_attempt_at" DROP DEFAULT');
    const restore = downStatements.indexOf(`CREATE UNIQUE INDEX "${PARTIAL_IDX}"`);
    expect(dropUq).toBeGreaterThanOrEqual(0);
    expect(dropCk).toBeGreaterThan(dropUq);
    expect(dropKeyNull).toBeGreaterThan(dropCk);
    expect(dropLastNull).toBeGreaterThan(dropKeyNull);
    expect(dropDefault).toBeGreaterThan(dropLastNull);
    expect(restore).toBeGreaterThan(dropDefault);
    expect(downStatements).toMatch(
      new RegExp(
        `CREATE UNIQUE INDEX "${PARTIAL_IDX}"\\s+ON "pay"\\."subscription_executions" \\("idempotency_key"\\)\\s+WHERE "idempotency_key" IS NOT NULL`,
      ),
    );
    expect(downStatements.match(/ALTER TABLE/g)).toHaveLength(5);
    expect(downStatements.match(/DROP NOT NULL/g)).toHaveLength(2);
    expect(downStatements.match(/DROP DEFAULT/g)).toHaveLength(1);
    expect(downStatements.match(/CREATE UNIQUE INDEX/g)).toHaveLength(1);
    expect(downStatements).not.toMatch(/\bSET\s+NOT\s+NULL\b/);
    expect(downStatements).not.toMatch(/\bSET\s+DEFAULT\b/);
    expect(downStatements).not.toMatch(/\bUPDATE\b|\bINSERT\b|\bDELETE\b|\bDROP\s+COLUMN\b/i);
    expect(downStatements).not.toMatch(/\bsubscriptions\b/);
    expect(downStatements).not.toContain(RETRY_IDX);
    expect(downStatements).not.toContain(OCCURRENCE_IDX);
    expect(downStatements).not.toMatch(/\bfloat\b|\bdouble\b|\breal\b|\bamount\b|\bledger\b/i);
    expect(closingDown).not.toContain('"pay"');
    expect(closingDown).toContain(`"${schema}"`);

    async function columnFact(table: string, name: string): Promise<ColumnFact> {
      return one(
        await db<ColumnFact[]>`
          SELECT is_nullable, column_default, data_type
            FROM information_schema.columns
           WHERE table_schema = ${schema}
             AND table_name = ${table}
             AND column_name = ${name}
        `,
        `${table}.${name}`,
      );
    }

    async function indexFact(name: string): Promise<IndexFact | undefined> {
      const rows = await db<IndexFact[]>`
        SELECT c.oid::text AS oid,
               i.indisunique AS is_unique,
               pg_get_expr(i.indpred, i.indrelid) AS pred,
               pg_get_indexdef(i.indexrelid) AS def
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          JOIN pg_class t ON t.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = ${schema}
           AND t.relname = 'subscription_executions'
           AND c.relname = ${name}
      `;
      return rows[0];
    }

    async function constraintFacts(names: readonly string[]): Promise<ConstraintFact[]> {
      return db<ConstraintFact[]>`
        SELECT con.oid::text AS oid, con.conname, con.contype, pg_get_constraintdef(con.oid) AS def
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ${schema}
           AND con.conname IN ${db(names)}
         ORDER BY con.conname
      `;
    }

    async function storedExecution(id: string): Promise<StoredExecution> {
      return one(
        await db<StoredExecution[]>`
          SELECT
            id,
            subscription_id,
            occurrence,
            status::text AS status,
            idempotency_key,
            last_attempt_at,
            (amount = ${AMOUNT}::numeric) AS amount_ok,
            ledger_tx_id
            FROM subscription_executions
           WHERE id = ${id}
        `,
        'stored execution',
      );
    }

    async function countText(where: postgres.PendingQuery<Array<{ n: string }>>): Promise<string> {
      return one(await where, 'count').n;
    }

    async function refused(run: () => Promise<unknown>): Promise<{ code?: string; message?: string; constraint_name?: string }> {
      const error = await run().then(
        () => null,
        (err: unknown) => err,
      );
      return (error ?? {}) as { code?: string; message?: string; constraint_name?: string };
    }

    const returning = db`
      RETURNING
        id,
        subscription_id,
        occurrence,
        status::text AS status,
        idempotency_key,
        last_attempt_at,
        (amount = ${AMOUNT}::numeric) AS amount_ok,
        ledger_tx_id
    `;

    async function insertBoth(occurrence: number, key: string | null, lastAttemptAt: Date | null): Promise<StoredExecution> {
      return one(
        await db<StoredExecution[]>`
          INSERT INTO subscription_executions (
            subscription_id, occurrence, amount, idempotency_key, last_attempt_at
          ) VALUES (
            ${subscriptionId},
            ${occurrence},
            ${AMOUNT}::numeric,
            ${key},
            ${lastAttemptAt}
          )
          ${returning}
        `,
        'execution',
      );
    }

    async function insertOmitKey(occurrence: number, lastAttemptAt: Date): Promise<StoredExecution> {
      return one(
        await db<StoredExecution[]>`
          INSERT INTO subscription_executions (
            subscription_id, occurrence, amount, last_attempt_at
          ) VALUES (
            ${subscriptionId},
            ${occurrence},
            ${AMOUNT}::numeric,
            ${lastAttemptAt}
          )
          ${returning}
        `,
        'execution without key',
      );
    }

    async function insertOmitLast(occurrence: number, key: string): Promise<StoredExecution> {
      return one(
        await db<StoredExecution[]>`
          INSERT INTO subscription_executions (
            subscription_id, occurrence, amount, idempotency_key
          ) VALUES (
            ${subscriptionId},
            ${occurrence},
            ${AMOUNT}::numeric,
            ${key}
          )
          ${returning}
        `,
        'execution without last_attempt_at',
      );
    }

    async function insertOmitBoth(occurrence: number): Promise<StoredExecution> {
      return one(
        await db<StoredExecution[]>`
          INSERT INTO subscription_executions (subscription_id, occurrence, amount)
          VALUES (${subscriptionId}, ${occurrence}, ${AMOUNT}::numeric)
          ${returning}
        `,
        'execution without key or last_attempt_at',
      );
    }

    const merchant = one(
      await db<Array<{ id: string }>>`
        INSERT INTO merchants (user_id)
        VALUES ('l879-merchant')
        RETURNING id
      `,
      'merchant',
    );
    const mandate = one(
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
    expect(mandate.amount_ok).toBe(true);
    const subscriptionId = one(
      await db<Array<{ id: string }>>`
        INSERT INTO subscriptions (
          mandate_id, merchant_id, customer_id, next_run_at, idempotency_key
        ) VALUES (
          ${mandate.id},
          ${mandate.merchant_id},
          ${mandate.customer_id},
          ${NEXT_RUN_AT},
          ${SUBSCRIPTION_KEY}
        )
        RETURNING id
      `,
      'subscription',
    ).id;

    const keyBefore = await columnFact('subscription_executions', 'idempotency_key');
    const lastBefore = await columnFact('subscription_executions', 'last_attempt_at');
    const attemptedDefault = await columnFact('subscription_executions', 'attempted_at');
    expect(keyBefore).toEqual({ is_nullable: 'YES', column_default: null, data_type: 'text' });
    expect(lastBefore).toEqual({
      is_nullable: 'YES',
      column_default: null,
      data_type: 'timestamp with time zone',
    });
    expect(attemptedDefault.column_default).toBeTruthy();

    const partialBefore = await indexFact(PARTIAL_IDX);
    const retryBefore = await indexFact(RETRY_IDX);
    const occurrenceBefore = await indexFact(OCCURRENCE_IDX);
    expect(partialBefore?.is_unique).toBe(true);
    expect(partialBefore?.pred ?? '').toContain('idempotency_key IS NOT NULL');
    expect(partialBefore?.def).toContain('UNIQUE');
    expect(retryBefore?.is_unique).toBe(false);
    expect(retryBefore?.pred ?? '').toContain('exhausted_at IS NULL');
    expect(retryBefore?.def).toContain('status');
    expect(retryBefore?.def).toContain('last_attempt_at');
    expect(occurrenceBefore?.is_unique).toBe(true);
    expect(await indexFact(KEY_UQ)).toBeUndefined();
    expect(await constraintFacts([KEY_CK, KEY_UQ])).toEqual([]);

    const subscriptionKeysBefore = await constraintFacts([SUB_KEY_CK, SUB_KEY_UQ]);
    expect(subscriptionKeysBefore.map((row) => row.conname)).toEqual([SUB_KEY_CK, SUB_KEY_UQ]);
    const subscriptionKeyColumnBefore = await columnFact('subscriptions', 'idempotency_key');

    const firstNull = await insertOmitBoth(0);
    const secondNull = await insertOmitBoth(1);
    expect(firstNull.idempotency_key).toBeNull();
    expect(secondNull.idempotency_key).toBeNull();
    expect(firstNull.last_attempt_at).toBeNull();
    expect(secondNull.last_attempt_at).toBeNull();
    expect(firstNull.amount_ok).toBe(true);
    expect(secondNull.amount_ok).toBe(true);
    expect(firstNull.ledger_tx_id).toBeNull();
    expect(secondNull.id).not.toBe(firstNull.id);
    expect(
      await countText(db`
        SELECT count(*)::text AS n
          FROM subscription_executions
         WHERE idempotency_key IS NULL
      `),
    ).toBe('2');

    const nullAttempt = await refused(() => db.unsafe(closing));
    expect(nullAttempt).toMatchObject({ code: '23502' });
    expect(nullAttempt.message ?? '').toContain('last_attempt_at');
    expect(await storedExecution(firstNull.id)).toEqual(firstNull);
    expect(await storedExecution(secondNull.id)).toEqual(secondNull);
    expect(await columnFact('subscription_executions', 'idempotency_key')).toEqual(keyBefore);
    expect(await columnFact('subscription_executions', 'last_attempt_at')).toEqual(lastBefore);
    expect(await indexFact(PARTIAL_IDX)).toEqual(partialBefore);
    expect(await indexFact(RETRY_IDX)).toEqual(retryBefore);

    await db`DELETE FROM subscription_executions`;
    const nullKey = await insertOmitKey(0, ATTEMPT_AT);
    expect(nullKey.idempotency_key).toBeNull();
    expect(nullKey.last_attempt_at).toEqual(ATTEMPT_AT);
    const nullKeyAttempt = await refused(() => db.unsafe(closing));
    expect(nullKeyAttempt).toMatchObject({ code: '23502' });
    expect(nullKeyAttempt.message ?? '').toContain('idempotency_key');
    expect(await storedExecution(nullKey.id)).toEqual(nullKey);
    expect(await columnFact('subscription_executions', 'last_attempt_at')).toEqual(lastBefore);
    expect(await indexFact(PARTIAL_IDX)).toEqual(partialBefore);

    await db`DELETE FROM subscription_executions`;
    const storedBlank = await insertBoth(0, SPACES, ATTEMPT_AT);
    expect(storedBlank.idempotency_key).toBe(SPACES);
    expect(storedBlank.last_attempt_at).toEqual(ATTEMPT_AT);
    const blankAttempt = await refused(() => db.unsafe(closing));
    expect(blankAttempt).toMatchObject({ code: '23514' });
    expect(blankAttempt.message ?? '').toContain(KEY_CK);
    expect(await storedExecution(storedBlank.id)).toEqual(storedBlank);
    expect(await columnFact('subscription_executions', 'idempotency_key')).toEqual(keyBefore);
    expect(await indexFact(KEY_UQ)).toBeUndefined();

    await db`DELETE FROM subscription_executions`;
    expect(await countText(db`SELECT count(*)::text AS n FROM subscription_executions`)).toBe('0');

    const keeper = await insertBoth(0, KEY_A, ATTEMPT_AT);
    expect(keeper).toMatchObject({
      subscription_id: subscriptionId,
      occurrence: 0,
      status: 'pending',
      idempotency_key: KEY_A,
      amount_ok: true,
      ledger_tx_id: null,
    });
    expect(keeper.last_attempt_at).toEqual(ATTEMPT_AT);

    await db.unsafe(closing);

    expect(await storedExecution(keeper.id)).toEqual(keeper);
    expect(await columnFact('subscription_executions', 'idempotency_key')).toEqual({
      is_nullable: 'NO',
      column_default: null,
      data_type: 'text',
    });
    expect(await columnFact('subscription_executions', 'last_attempt_at')).toEqual({
      is_nullable: 'NO',
      column_default: attemptedDefault.column_default,
      data_type: 'timestamp with time zone',
    });
    expect(await indexFact(PARTIAL_IDX)).toBeUndefined();
    expect(await indexFact(RETRY_IDX)).toEqual(retryBefore);
    expect(await indexFact(OCCURRENCE_IDX)).toEqual(occurrenceBefore);
    const executionConstraints = await constraintFacts([KEY_CK, KEY_UQ]);
    expect(executionConstraints.map(({ conname, contype, def }) => ({ conname, contype, def }))).toEqual([
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
    const fullUnique = await indexFact(KEY_UQ);
    expect(fullUnique?.is_unique).toBe(true);
    expect(fullUnique?.pred).toBeNull();
    expect(fullUnique?.def).toContain('UNIQUE');
    expect(fullUnique?.def).toContain('(idempotency_key)');
    expect(fullUnique?.def).not.toMatch(/WHERE/i);
    expect(fullUnique?.def).not.toMatch(/NULLS NOT DISTINCT/i);
    expect(await constraintFacts([SUB_KEY_CK, SUB_KEY_UQ])).toEqual(subscriptionKeysBefore);
    expect(await columnFact('subscriptions', 'idempotency_key')).toEqual(subscriptionKeyColumnBefore);

    const duplicate = await refused(() => insertBoth(1, KEY_A, ATTEMPT_AT));
    expect(duplicate).toMatchObject({ code: '23505' });
    expect(duplicate.message ?? '').toContain(KEY_UQ);
    expect(duplicate.message ?? '').not.toContain(OCCURRENCE_IDX);
    expect(await countText(db`SELECT count(*)::text AS n FROM subscription_executions WHERE idempotency_key = ${KEY_A}`)).toBe('1');
    expect(await storedExecution(keeper.id)).toEqual(keeper);

    const emptyKey = await refused(() => insertBoth(1, '', ATTEMPT_AT));
    expect(emptyKey).toMatchObject({ code: '23514', constraint_name: KEY_CK });
    const spaceKey = await refused(() => insertBoth(1, SPACES, ATTEMPT_AT));
    expect(spaceKey).toMatchObject({ code: '23514', constraint_name: KEY_CK });

    const missingKey = await refused(() => insertOmitLast(1, ''));
    const missing = await refused(() =>
      db`
        INSERT INTO subscription_executions (subscription_id, occurrence, amount, last_attempt_at)
        VALUES (${subscriptionId}, 1, ${AMOUNT}::numeric, ${ATTEMPT_AT})
      `,
    );
    expect(missing).toMatchObject({ code: '23502' });
    expect(missing.message ?? '').toContain('idempotency_key');
    expect(missingKey.code).toBe('23514');

    const other = await insertBoth(1, KEY_B, ATTEMPT_AT);
    expect(other.idempotency_key).toBe(KEY_B);
    expect(other.id).not.toBe(keeper.id);
    expect(other.amount_ok).toBe(true);
    expect(other.ledger_tx_id).toBeNull();
    expect(other.last_attempt_at).toEqual(ATTEMPT_AT);

    const omittedAttempt = await insertOmitLast(2, KEY_C);
    expect(omittedAttempt.idempotency_key).toBe(KEY_C);
    expect(omittedAttempt.last_attempt_at).toBeInstanceOf(Date);
    expect(Math.abs((omittedAttempt.last_attempt_at as Date).getTime() - Date.now())).toBeLessThan(60_000);
    expect(omittedAttempt.amount_ok).toBe(true);
    expect(await storedExecution(keeper.id)).toEqual(keeper);
    expect(
      await countText(db`
        SELECT count(*)::text AS n
          FROM subscription_executions
         WHERE idempotency_key IN (${KEY_A}, ${KEY_B}, ${KEY_C})
      `),
    ).toBe('3');

    await db.unsafe(closingDown);

    expect(await storedExecution(keeper.id)).toEqual(keeper);
    expect(await storedExecution(other.id)).toEqual(other);
    expect(await storedExecution(omittedAttempt.id)).toEqual(omittedAttempt);
    expect(await columnFact('subscription_executions', 'idempotency_key')).toEqual(keyBefore);
    expect(await columnFact('subscription_executions', 'last_attempt_at')).toEqual(lastBefore);
    expect(await constraintFacts([KEY_CK, KEY_UQ])).toEqual([]);
    expect(await indexFact(KEY_UQ)).toBeUndefined();
    expect(await indexFact(RETRY_IDX)).toEqual(retryBefore);
    expect(await indexFact(OCCURRENCE_IDX)).toEqual(occurrenceBefore);
    expect(await constraintFacts([SUB_KEY_CK, SUB_KEY_UQ])).toEqual(subscriptionKeysBefore);
    const partialAfter = await indexFact(PARTIAL_IDX);
    expect(partialAfter?.is_unique).toBe(true);
    expect(partialAfter?.pred ?? '').toContain('idempotency_key IS NOT NULL');
    expect(partialAfter?.def).toContain('UNIQUE');
    expect(partialAfter?.oid).not.toBe(partialBefore?.oid);

    const nullAgain = await insertOmitBoth(3);
    const nullAgainToo = await insertOmitBoth(4);
    expect(nullAgain.idempotency_key).toBeNull();
    expect(nullAgain.last_attempt_at).toBeNull();
    expect(nullAgainToo.idempotency_key).toBeNull();
    expect(nullAgainToo.last_attempt_at).toBeNull();
    expect(nullAgain.amount_ok).toBe(true);
    expect(nullAgainToo.amount_ok).toBe(true);
    expect(nullAgain.id).not.toBe(nullAgainToo.id);

    const duplicateAfterDown = await refused(() => insertBoth(5, KEY_A, ATTEMPT_AT));
    expect(duplicateAfterDown).toMatchObject({ code: '23505' });
    expect(duplicateAfterDown.message ?? '').toContain(PARTIAL_IDX);
    expect(duplicateAfterDown.message ?? '').not.toContain(KEY_UQ);
    expect(await storedExecution(keeper.id)).toEqual(keeper);

    const fourth = await insertOmitLast(5, KEY_D);
    expect(fourth.idempotency_key).toBe(KEY_D);
    expect(fourth.last_attempt_at).toBeNull();
    expect(fourth.amount_ok).toBe(true);
    expect(
      await countText(db`
        SELECT count(*)::text AS n
          FROM subscription_mandates
         WHERE id = ${mandate.id}
           AND amount = ${AMOUNT}::numeric
      `),
    ).toBe('1');
  });
});
