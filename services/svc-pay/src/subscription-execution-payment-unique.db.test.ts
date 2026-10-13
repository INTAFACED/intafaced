import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * subscription_executions.payment_id and ledger_tx_id link an occurrence to a
 * payment and a ledger transaction. Unique (subscription_id, occurrence)
 * stops two rows for the same occurrence. It does not stop two occurrences,
 * including on different subscriptions, from storing the same payment_id or
 * the same ledger_tx_id and both being marked settled. The payment lookup
 * index is not unique.
 *
 * 0033 adds a unique index on payment_id WHERE payment_id IS NOT NULL, and a
 * unique index on ledger_tx_id WHERE ledger_tx_id IS NOT NULL. Multiple NULL
 * payment_id rows stay allowed. Multiple NULL ledger_tx_id rows stay allowed.
 * NULLS NOT DISTINCT is not used. A second occurrence, including on a
 * different subscription, that stores the same payment_id refuses 23505. The
 * same payment_id or ledger_tx_id on a second row refuses the same way. The
 * unique (subscription_id, occurrence) stays. The non-unique payment lookup
 * index stays. Stored rows are not rewritten. If duplicates already exist,
 * creating the unique index fails and those rows stay. There is no upsert
 * and no ledger post. Money stays numeric. The down file drops only the two
 * new unique indexes.
 *
 * Prior forward files are applied first, including 0032. Pay SQL is
 * schema-qualified and rewritten onto a schema in the database
 * TEST_DATABASE_URL names. This file does not start Postgres and does not
 * create a database.
 *
 * The fixture merchant, customer, asset, currency, method, and rail live
 * only in this test. The amount is the decimal string '10' only. 'tx-1' is
 * a fixture label, not a product constant.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const CLOSING = '0033_pay_subscription_execution_payment_unique.sql';
const CLOSING_DOWN = '0033_pay_subscription_execution_payment_unique.down.sql';

const PAYMENT_UQ = 'subscription_executions_payment_id_uq';
const LEDGER_UQ = 'subscription_executions_ledger_tx_id_uq';
const OCCURRENCE_IDX = 'subscription_executions_occurrence_idx';
const PAYMENT_IDX = 'subscription_executions_payment_idx';

const FIXTURE_CUSTOMER = 'l878-fixture-customer';
const FIXTURE_ASSET = 'l878-fixture-asset';
/** Decimal string. The only amount in this test. Not a product magnitude. */
const AMOUNT = '10';
/** Fixture label, not a product constant. */
const LEDGER_TX = 'tx-1';
const STARTS_AT = new Date('2026-01-15T00:00:00.000Z');
const NEXT_RUN_AT = new Date('2026-02-15T00:00:00.000Z');
const SETTLED_AT = new Date('2026-02-15T00:00:00.000Z');
const ROLLBACK = 'rollback-open-duplicate';

const KEY_A = 'l878-key-a';
const KEY_B = 'l878-key-b';

const priorMigrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql') && f !== CLOSING)
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error('TEST_DATABASE_URL is unset; refusing to guess a database for one payment settling two executions');
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

interface ExecutionInput {
  subscriptionId: string;
  occurrence: number;
  paymentId: string | null;
  ledgerTxId: string | null;
}

interface StoredExecution {
  id: string;
  subscription_id: string;
  occurrence: number;
  status: string;
  payment_id: string | null;
  ledger_tx_id: string | null;
  amount_ok: boolean;
}

interface IndexFact {
  is_unique: boolean;
  pred: string | null;
  def: string;
}

describe('one payment and one ledger transaction can settle only one execution', () => {
  let sql: postgres.Sql | undefined;
  let admin: postgres.Sql | undefined;
  let schema = '';

  beforeAll(async () => {
    const url = testDatabaseUrl();
    admin = postgres(url, { max: 1, onnotice: () => undefined });
    const current = one(await admin<Array<{ db: string }>>`SELECT current_database() AS db`, 'current database');
    if (!current.db.endsWith('_test')) {
      throw new Error(`refusing to migrate one payment settling two executions on database ${current.db}`);
    }
    if (current.db === 'postgres') {
      throw new Error('refusing to migrate one payment settling two executions on database postgres');
    }

    schema = `test_pay_l878_${process.pid}`;
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

  it('refuses a second settled execution with the same payment or ledger transaction, and keeps two null links', async () => {
    if (!sql || !schema) throw new Error('test database was not opened');
    const db = (() => {
      if (!sql) throw new Error('Native test database was not opened');
      return sql;
    })();

    const raw = readFileSync(join(drizzleDir, CLOSING), 'utf8');
    const rawDown = readFileSync(join(drizzleDir, CLOSING_DOWN), 'utf8');
    const closing = rewritePaySchema(raw, schema);
    const closingDown = rewritePaySchema(rawDown, schema);
    const statements = stripSqlComments(raw);
    const downStatements = stripSqlComments(rawDown);

    const paymentIndexAt = statements.indexOf(`"${PAYMENT_UQ}"`);
    const ledgerIndexAt = statements.indexOf(`"${LEDGER_UQ}"`);
    expect(paymentIndexAt).toBeGreaterThanOrEqual(0);
    expect(ledgerIndexAt).toBeGreaterThan(paymentIndexAt);
    expect(statements).toMatch(
      new RegExp(
        `CREATE UNIQUE INDEX "${PAYMENT_UQ}"\\s+ON "pay"\\."subscription_executions" \\("payment_id"\\)\\s+WHERE "payment_id" IS NOT NULL`,
      ),
    );
    expect(statements).toMatch(
      new RegExp(
        `CREATE UNIQUE INDEX "${LEDGER_UQ}"\\s+ON "pay"\\."subscription_executions" \\("ledger_tx_id"\\)\\s+WHERE "ledger_tx_id" IS NOT NULL`,
      ),
    );
    expect(statements.match(/CREATE UNIQUE INDEX/g)).toHaveLength(2);
    expect(statements).not.toMatch(/\bNULLS\s+NOT\s+DISTINCT\b/i);
    expect(statements).not.toMatch(/\bIF\s+NOT\s+EXISTS\b/i);
    expect(statements).not.toMatch(/\bDROP\b/i);
    expect(statements).not.toMatch(/\bINSERT\b/i);
    expect(statements).not.toMatch(/\bUPDATE\b/i);
    expect(statements).not.toMatch(/\bDELETE\b/i);
    expect(statements).not.toMatch(/\bALTER\b/i);
    expect(statements).not.toMatch(/\bON\s+CONFLICT\b/i);
    expect(statements).not.toMatch(/\bfloat\b|\bdouble\b|\breal\b/i);
    expect(statements).not.toContain(OCCURRENCE_IDX);
    expect(statements).not.toContain(PAYMENT_IDX);
    expect(closing).not.toContain('"pay"');
    expect(closing).toContain(`"${schema}"`);

    const dropPaymentAt = downStatements.indexOf(`DROP INDEX IF EXISTS "pay"."${PAYMENT_UQ}"`);
    const dropLedgerAt = downStatements.indexOf(`DROP INDEX IF EXISTS "pay"."${LEDGER_UQ}"`);
    expect(dropLedgerAt).toBeGreaterThanOrEqual(0);
    expect(dropPaymentAt).toBeGreaterThan(dropLedgerAt);
    expect(downStatements.match(/DROP\s+INDEX/gi)).toHaveLength(2);
    expect(downStatements).not.toMatch(/\bNULLS\s+NOT\s+DISTINCT\b/i);
    expect(downStatements).not.toMatch(/\bINSERT\b/i);
    expect(downStatements).not.toMatch(/\bUPDATE\b/i);
    expect(downStatements).not.toMatch(/\bDELETE\b/i);
    expect(downStatements).not.toMatch(/\bALTER\b/i);
    expect(downStatements).not.toMatch(/\bON\s+CONFLICT\b/i);
    expect(downStatements).not.toContain(OCCURRENCE_IDX);
    expect(downStatements).not.toContain(PAYMENT_IDX);
    expect(closingDown).not.toContain('"pay"');

    async function insertExecution(q: postgres.Sql | postgres.TransactionSql, input: ExecutionInput): Promise<StoredExecution> {
      return one(
        await q<StoredExecution[]>`
          INSERT INTO subscription_executions (
            subscription_id, occurrence, amount, status, payment_id, ledger_tx_id, settled_at
          ) VALUES (
            ${input.subscriptionId},
            ${input.occurrence},
            ${AMOUNT}::numeric,
            'settled',
            ${input.paymentId},
            ${input.ledgerTxId},
            ${SETTLED_AT}
          )
          RETURNING
            id,
            subscription_id,
            occurrence,
            status::text AS status,
            payment_id,
            ledger_tx_id,
            (amount = ${AMOUNT}::numeric) AS amount_ok
        `,
        'execution',
      );
    }

    async function storedExecution(id: string): Promise<StoredExecution> {
      return one(
        await db<StoredExecution[]>`
          SELECT
            id,
            subscription_id,
            occurrence,
            status::text AS status,
            payment_id,
            ledger_tx_id,
            (amount = ${AMOUNT}::numeric) AS amount_ok
            FROM subscription_executions
           WHERE id = ${id}
        `,
        'stored execution',
      );
    }

    async function countText(where: postgres.PendingQuery<Array<{ n: string }>>): Promise<string> {
      return one(await where, 'count').n;
    }

    async function indexFact(name: string): Promise<IndexFact | undefined> {
      const rows = await db<IndexFact[]>`
        SELECT i.indisunique AS is_unique,
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

    async function expectUniqueRefused(run: () => Promise<unknown>, indexName: string): Promise<void> {
      const error = await run().then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).toMatchObject({ code: '23505' });
      const message = String((error as { message?: string }).message);
      expect(message).toContain(indexName);
      expect(message).not.toContain(OCCURRENCE_IDX);
    }

    async function withRollback(run: (tx: postgres.TransactionSql) => Promise<void>): Promise<void> {
      const error = await db
        .begin(async (tx) => {
          await run(tx);
          throw new Error(ROLLBACK);
        })
        .then(
          () => null,
          (err: unknown) => err,
        );
      expect((error as { message?: string } | null)?.message).toBe(ROLLBACK);
    }

    const merchant = one(
      await db<Array<{ id: string }>>`
        INSERT INTO merchants (user_id)
        VALUES ('l878-merchant')
        RETURNING id
      `,
      'merchant',
    );

    async function insertMandate(): Promise<{ id: string; merchant_id: string; customer_id: string }> {
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
        'mandate',
      );
    }

    async function insertSubscription(mandateId: string, merchantId: string, customerId: string, key: string): Promise<string> {
      const row = one(
        await db<Array<{ id: string }>>`
          INSERT INTO subscriptions (
            mandate_id, merchant_id, customer_id, next_run_at
          ) VALUES (
            ${mandateId},
            ${merchantId},
            ${customerId},
            ${NEXT_RUN_AT}
          )
          RETURNING id
        `,
        'subscription',
      );
      return row.id;
    }

    const mandateA = await insertMandate();
    const mandateB = await insertMandate();
    const subA = await insertSubscription(mandateA.id, mandateA.merchant_id, mandateA.customer_id, KEY_A);
    const subB = await insertSubscription(mandateB.id, mandateB.merchant_id, mandateB.customer_id, KEY_B);
    const payment = one(
      await db<Array<{ id: string; amount_ok: boolean }>>`
        INSERT INTO payments (merchant_id, amount, currency, method, rail_adapter)
        VALUES (${merchant.id}, ${AMOUNT}::numeric, 'USD', 'card', 'card')
        RETURNING id, (amount = ${AMOUNT}::numeric) AS amount_ok
      `,
      'payment',
    );
    expect(payment.amount_ok).toBe(true);

    await withRollback(async (tx) => {
      const first = await insertExecution(tx, {
        subscriptionId: subA,
        occurrence: 0,
        paymentId: payment.id,
        ledgerTxId: null,
      });
      const second = await insertExecution(tx, {
        subscriptionId: subB,
        occurrence: 0,
        paymentId: payment.id,
        ledgerTxId: null,
      });
      expect(first.amount_ok).toBe(true);
      expect(second.amount_ok).toBe(true);
      expect(first.status).toBe('settled');
      expect(second.status).toBe('settled');
      expect(second.subscription_id).not.toBe(first.subscription_id);
      expect(second.payment_id).toBe(payment.id);
    });

    await withRollback(async (tx) => {
      const first = await insertExecution(tx, {
        subscriptionId: subA,
        occurrence: 0,
        paymentId: null,
        ledgerTxId: LEDGER_TX,
      });
      const second = await insertExecution(tx, {
        subscriptionId: subB,
        occurrence: 0,
        paymentId: null,
        ledgerTxId: LEDGER_TX,
      });
      expect(first.ledger_tx_id).toBe(LEDGER_TX);
      expect(second.ledger_tx_id).toBe(LEDGER_TX);
      expect(second.subscription_id).not.toBe(first.subscription_id);
      expect(first.status).toBe('settled');
      expect(second.status).toBe('settled');
    });

    expect(await countText(db`SELECT count(*)::text AS n FROM subscription_executions`)).toBe('0');

    const occurrenceBefore = await indexFact(OCCURRENCE_IDX);
    const paymentLookupBefore = await indexFact(PAYMENT_IDX);
    expect(occurrenceBefore?.is_unique).toBe(true);
    expect(occurrenceBefore?.pred).toBeNull();
    expect(occurrenceBefore?.def).toContain('subscription_id');
    expect(occurrenceBefore?.def).toContain('occurrence');
    expect(paymentLookupBefore?.is_unique).toBe(false);
    expect(paymentLookupBefore?.pred ?? '').toContain('payment_id IS NOT NULL');
    expect(paymentLookupBefore?.def).not.toContain('UNIQUE');
    expect(await indexFact(PAYMENT_UQ)).toBeUndefined();
    expect(await indexFact(LEDGER_UQ)).toBeUndefined();

    const paymentKeeper = await insertExecution(db, {
      subscriptionId: subA,
      occurrence: 0,
      paymentId: payment.id,
      ledgerTxId: null,
    });
    const ledgerKeeper = await insertExecution(db, {
      subscriptionId: subB,
      occurrence: 0,
      paymentId: null,
      ledgerTxId: LEDGER_TX,
    });
    expect(paymentKeeper).toMatchObject({
      subscription_id: subA,
      occurrence: 0,
      status: 'settled',
      payment_id: payment.id,
      ledger_tx_id: null,
      amount_ok: true,
    });
    expect(ledgerKeeper).toMatchObject({
      subscription_id: subB,
      occurrence: 0,
      status: 'settled',
      payment_id: null,
      ledger_tx_id: LEDGER_TX,
      amount_ok: true,
    });

    await db.unsafe(closing);

    expect(await storedExecution(paymentKeeper.id)).toEqual(paymentKeeper);
    expect(await storedExecution(ledgerKeeper.id)).toEqual(ledgerKeeper);
    expect(await indexFact(OCCURRENCE_IDX)).toEqual(occurrenceBefore);
    expect(await indexFact(PAYMENT_IDX)).toEqual(paymentLookupBefore);

    const paymentUnique = await indexFact(PAYMENT_UQ);
    const ledgerUnique = await indexFact(LEDGER_UQ);
    expect(paymentUnique?.is_unique).toBe(true);
    expect(paymentUnique?.pred ?? '').toContain('payment_id IS NOT NULL');
    expect(paymentUnique?.def).toContain('UNIQUE');
    expect(paymentUnique?.def).toContain('(payment_id)');
    expect(paymentUnique?.def).not.toMatch(/NULLS NOT DISTINCT/i);
    expect(ledgerUnique?.is_unique).toBe(true);
    expect(ledgerUnique?.pred ?? '').toContain('ledger_tx_id IS NOT NULL');
    expect(ledgerUnique?.def).toContain('UNIQUE');
    expect(ledgerUnique?.def).toContain('(ledger_tx_id)');
    expect(ledgerUnique?.def).not.toMatch(/NULLS NOT DISTINCT/i);

    await expectUniqueRefused(
      () =>
        insertExecution(db, {
          subscriptionId: subB,
          occurrence: 1,
          paymentId: payment.id,
          ledgerTxId: null,
        }),
      PAYMENT_UQ,
    );
    expect(
      await countText(db`
        SELECT count(*)::text AS n
          FROM subscription_executions
         WHERE payment_id = ${payment.id}
      `),
    ).toBe('1');
    expect(await storedExecution(paymentKeeper.id)).toEqual(paymentKeeper);

    await expectUniqueRefused(
      () =>
        insertExecution(db, {
          subscriptionId: subA,
          occurrence: 1,
          paymentId: null,
          ledgerTxId: LEDGER_TX,
        }),
      LEDGER_UQ,
    );
    expect(
      await countText(db`
        SELECT count(*)::text AS n
          FROM subscription_executions
         WHERE ledger_tx_id = ${LEDGER_TX}
      `),
    ).toBe('1');
    expect(await storedExecution(ledgerKeeper.id)).toEqual(ledgerKeeper);

    const nullA = await insertExecution(db, {
      subscriptionId: subA,
      occurrence: 2,
      paymentId: null,
      ledgerTxId: null,
    });
    const nullB = await insertExecution(db, {
      subscriptionId: subB,
      occurrence: 2,
      paymentId: null,
      ledgerTxId: null,
    });
    expect(nullA.payment_id).toBeNull();
    expect(nullA.ledger_tx_id).toBeNull();
    expect(nullB.payment_id).toBeNull();
    expect(nullB.ledger_tx_id).toBeNull();
    expect(nullA.id).not.toBe(nullB.id);
    expect(nullA.amount_ok).toBe(true);
    expect(nullB.amount_ok).toBe(true);
    expect(
      await countText(db`
        SELECT count(*)::text AS n
          FROM subscription_executions
         WHERE payment_id IS NULL
           AND ledger_tx_id IS NULL
      `),
    ).toBe('2');

    await db.unsafe(closingDown);

    expect(await indexFact(PAYMENT_UQ)).toBeUndefined();
    expect(await indexFact(LEDGER_UQ)).toBeUndefined();
    expect(await indexFact(OCCURRENCE_IDX)).toEqual(occurrenceBefore);
    expect(await indexFact(PAYMENT_IDX)).toEqual(paymentLookupBefore);
    expect(await storedExecution(paymentKeeper.id)).toEqual(paymentKeeper);
    expect(await storedExecution(ledgerKeeper.id)).toEqual(ledgerKeeper);
    expect(await storedExecution(nullA.id)).toEqual(nullA);
    expect(await storedExecution(nullB.id)).toEqual(nullB);

    const secondPayment = await insertExecution(db, {
      subscriptionId: subB,
      occurrence: 1,
      paymentId: payment.id,
      ledgerTxId: null,
    });
    expect(secondPayment.subscription_id).toBe(subB);
    expect(secondPayment.payment_id).toBe(payment.id);
    expect(secondPayment.status).toBe('settled');
    expect(secondPayment.amount_ok).toBe(true);
    expect(secondPayment.subscription_id).not.toBe(paymentKeeper.subscription_id);

    const secondLedger = await insertExecution(db, {
      subscriptionId: subA,
      occurrence: 1,
      paymentId: null,
      ledgerTxId: LEDGER_TX,
    });
    expect(secondLedger.ledger_tx_id).toBe(LEDGER_TX);
    expect(secondLedger.status).toBe('settled');
    expect(secondLedger.amount_ok).toBe(true);
    expect(secondLedger.subscription_id).not.toBe(ledgerKeeper.subscription_id);

    expect(
      await countText(db`
        SELECT count(*)::text AS n
          FROM subscription_executions
         WHERE payment_id = ${payment.id}
      `),
    ).toBe('2');
    expect(
      await countText(db`
        SELECT count(*)::text AS n
          FROM subscription_executions
         WHERE ledger_tx_id = ${LEDGER_TX}
      `),
    ).toBe('2');
  });
});
