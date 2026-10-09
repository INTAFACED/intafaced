import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';

/**
 * pay.payments.amount is the authorized amount. 0020 refuses a change to it.
 *
 * The suite stands the schema up the way the other pay migration suites do:
 * every forward file under drizzle/, in order, on a per-run schema. Pay SQL is
 * schema-qualified, so each file is rewritten onto that schema before apply.
 * The database is the local intafaced_test instance. This file does not start
 * Postgres.
 *
 * Amounts are decimal strings inside the SQL. A JavaScript number is never
 * passed for a payment amount.
 */

const URL = 'postgres://Nitro@127.0.0.1:5432/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');

const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'pay', schema));

const AUTHORIZED = '10.500000000000000000';
const REWRITTEN = '11.500000000000000000';

function one<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`expected ${what}`);
  return row;
}

describe('pay.payments.amount stays the authorized amount', () => {
  let db: TestDb | undefined;

  beforeAll(async () => {
    db = await createTestDb({ service: 'pay_amount_frozen', url: URL, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('refuses an amount change and still stores an update of another column', async () => {
    const sql = db?.sql;
    const schema = db?.schema;
    if (!sql || !schema) throw new Error('test database was not opened');

    const merchant = one(
      await sql<Array<{ id: string }>>`
        INSERT INTO merchants (user_id)
        VALUES ('l866-amount-frozen')
        RETURNING id
      `,
      'merchant',
    );

    const payment = one(
      await sql<Array<{ id: string; amount: string }>>`
        INSERT INTO payments (merchant_id, amount, currency, method, rail_adapter)
        VALUES (${merchant.id}, ${AUTHORIZED}::numeric(38, 18), 'USD', 'card', 'card-sandbox')
        RETURNING id, amount::text AS amount
      `,
      'payment',
    );
    expect(typeof payment.amount).toBe('string');
    expect(payment.amount).toBe(AUTHORIZED);

    const trigger = one(
      await sql<Array<{ tgname: string }>>`
        SELECT t.tgname
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ${schema}
           AND c.relname = 'payments'
           AND t.tgname = 'payments_amount_frozen_trg'
           AND NOT t.tgisinternal
      `,
      'payments_amount_frozen_trg',
    );
    expect(trigger.tgname).toBe('payments_amount_frozen_trg');

    const scored = one(
      await sql<Array<{ amount: string; risk_score: number }>>`
        UPDATE payments
           SET risk_score = 40
         WHERE id = ${payment.id}
        RETURNING amount::text AS amount, risk_score
      `,
      'risk_score update',
    );
    expect(scored.amount).toBe(AUTHORIZED);
    expect(scored.risk_score).toBe(40);

    const referenced = one(
      await sql<Array<{ amount: string; rail_ref: string }>>`
        UPDATE payments
           SET rail_ref = 'rail-l866'
         WHERE id = ${payment.id}
        RETURNING amount::text AS amount, rail_ref
      `,
      'rail_ref update',
    );
    expect(referenced.amount).toBe(AUTHORIZED);
    expect(referenced.rail_ref).toBe('rail-l866');

    const authorized = one(
      await sql<Array<{ amount: string; status: string }>>`
        UPDATE payments
           SET status = 'authorized'
         WHERE id = ${payment.id}
        RETURNING amount::text AS amount, status
      `,
      'status update',
    );
    expect(authorized.amount).toBe(AUTHORIZED);
    expect(authorized.status).toBe('authorized');

    const same = one(
      await sql<Array<{ amount: string }>>`
        UPDATE payments
           SET amount = ${AUTHORIZED}::numeric(38, 18)
         WHERE id = ${payment.id}
        RETURNING amount::text AS amount
      `,
      'same amount update',
    );
    expect(same.amount).toBe(AUTHORIZED);

    await expect(
      sql`
        UPDATE payments
           SET amount = ${REWRITTEN}::numeric(38, 18)
         WHERE id = ${payment.id}
      `,
    ).rejects.toThrow(/authorized amount and never changes/);

    const stored = one(
      await sql<Array<{ amount: string; status: string; rail_ref: string; risk_score: number }>>`
        SELECT amount::text AS amount, status, rail_ref, risk_score
          FROM payments
         WHERE id = ${payment.id}
      `,
      'stored payment',
    );
    expect(stored.amount).toBe(AUTHORIZED);
    expect(stored.amount).not.toBe(REWRITTEN);
    expect(stored.status).toBe('authorized');
    expect(stored.rail_ref).toBe('rail-l866');
    expect(stored.risk_score).toBe(40);

    const events = one(
      await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n
          FROM payment_events
         WHERE payment_id = ${payment.id}
      `,
      'payment_events count',
    );
    expect(events.n).toBe(0);

    const down = readFileSync(join(drizzleDir, '0020_pay_payments_amount_frozen.down.sql'), 'utf8');
    await sql.unsafe(rewriteSchemaSql(down, 'pay', schema));

    const triggers = await sql<Array<{ tgname: string }>>`
      SELECT t.tgname
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ${schema}
         AND c.relname = 'payments'
         AND t.tgname = 'payments_amount_frozen_trg'
         AND NOT t.tgisinternal
    `;
    expect(triggers).toEqual([]);

    const column = one(
      await sql<Array<{ data_type: string; numeric_precision: number; numeric_scale: number }>>`
        SELECT data_type, numeric_precision, numeric_scale
          FROM information_schema.columns
         WHERE table_schema = ${schema}
           AND table_name = 'payments'
           AND column_name = 'amount'
      `,
      'payments.amount column',
    );
    expect(column.data_type).toBe('numeric');
    expect(column.numeric_precision).toBe(38);
    expect(column.numeric_scale).toBe(18);

    const afterDown = one(
      await sql<Array<{ amount: string }>>`
        SELECT amount::text AS amount
          FROM payments
         WHERE id = ${payment.id}
      `,
      'amount after down',
    );
    expect(afterDown.amount).toBe(AUTHORIZED);
  });
});
