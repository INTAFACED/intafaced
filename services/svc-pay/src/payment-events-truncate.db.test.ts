import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * payment_events is the chargeback history and the captured and refunded
 * totals. 0000 refuses UPDATE and DELETE with a row trigger. TRUNCATE does
 * not fire that trigger. 0023 attaches the same function as a BEFORE
 * TRUNCATE statement trigger. An empty table raises, and so does CASCADE
 * from a parent. The migration is applied again after a captured row is
 * stored, so that apply is what the stored-row assertions measure.
 *
 * Prior forward files are applied first. Pay SQL is schema-qualified and
 * rewritten onto a schema in the database TEST_DATABASE_URL names. This file
 * does not start Postgres and does not create a database.
 *
 * Amounts are decimal strings inside the SQL. A JavaScript number is never
 * passed for an amount.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const CLOSING = '0023_pay_payment_events_truncate.sql';
const CLOSING_DOWN = '0023_pay_payment_events_truncate.down.sql';

const AUTHORIZED = '10.500000000000000000';
const CAPTURED = '10.500000000000000000';
const REFUNDED = '4.250000000000000000';

const priorMigrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql') && f !== CLOSING)
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error('TEST_DATABASE_URL is unset; refusing to guess a database for payment events');
  }
  return url;
}

function rewritePaySchema(sql: string, schema: string): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(schema)) {
    throw new Error(`refusing to rewrite pay SQL onto ${schema}`);
  }
  return sql.replaceAll('"pay"', `"${schema}"`).replace(/\bpay\./g, `${schema}.`);
}

function one<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`expected ${what}`);
  return row;
}

interface StoredEvent {
  id: string;
  payment_id: string;
  event: string;
  amount: string;
  seq: string;
}

describe('payment_events refuses TRUNCATE and keeps the stored history', () => {
  let sql: postgres.Sql | undefined;
  let admin: postgres.Sql | undefined;
  let schema = '';

  beforeAll(async () => {
    const url = testDatabaseUrl();
    admin = postgres(url, { max: 1, onnotice: () => undefined });
    const current = one(await admin<Array<{ db: string }>>`SELECT current_database() AS db`, 'current database');
    if (!current.db.endsWith('_test')) {
      throw new Error(`refusing to migrate payment events on database ${current.db}`);
    }

    schema = `test_pay_l867_${process.pid}`;
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

  it('refuses TRUNCATE, including an empty table and CASCADE from a parent, refuses UPDATE and DELETE, stores an insert, and leaves the captured row in place', async () => {
    const db = sql;
    if (!db || !schema) throw new Error('test database was not opened');

    const closing = rewritePaySchema(readFileSync(join(drizzleDir, CLOSING), 'utf8'), schema);
    const closingDown = rewritePaySchema(readFileSync(join(drizzleDir, CLOSING_DOWN), 'utf8'), schema);

    await db.unsafe(closing);
    await expect(db.unsafe(`TRUNCATE "${schema}".payment_events`)).rejects.toThrow(/TRUNCATE is not permitted/);
    await expect(db.unsafe(`TRUNCATE "${schema}".merchants RESTART IDENTITY CASCADE`)).rejects.toThrow(
      /TRUNCATE is not permitted/,
    );
    await db.unsafe(closingDown);

    const merchant = one(
      await db<Array<{ id: string }>>`
        INSERT INTO merchants (user_id)
        VALUES ('l867-payment-events')
        RETURNING id
      `,
      'merchant',
    );
    const payment = one(
      await db<Array<{ id: string }>>`
        INSERT INTO payments (merchant_id, amount, currency, method, rail_adapter)
        VALUES (${merchant.id}, ${AUTHORIZED}::numeric(38, 18), 'USD', 'card', 'card-sandbox')
        RETURNING id
      `,
      'payment',
    );
    const captured = one(
      await db<StoredEvent[]>`
        INSERT INTO payment_events (payment_id, event, payload)
        VALUES (
          ${payment.id},
          'captured',
          jsonb_build_object('amount', ${CAPTURED}::text)
        )
        RETURNING id, payment_id, event, payload->>'amount' AS amount, seq::text AS seq
      `,
      'captured event',
    );
    expect(captured.event).toBe('captured');
    expect(captured.amount).toBe(CAPTURED);
    expect(captured.payment_id).toBe(payment.id);

    await db.unsafe(closing);

    const afterMigration = one(
      await db<StoredEvent[]>`
        SELECT id, payment_id, event, payload->>'amount' AS amount, seq::text AS seq
          FROM payment_events
         WHERE id = ${captured.id}
      `,
      'captured event after the closing migration',
    );
    expect(afterMigration).toEqual(captured);

    await expect(db.unsafe(`TRUNCATE "${schema}".payment_events`)).rejects.toThrow(/TRUNCATE is not permitted/);

    const afterTruncate = one(
      await db<StoredEvent[]>`
        SELECT id, payment_id, event, payload->>'amount' AS amount, seq::text AS seq
          FROM payment_events
         WHERE id = ${captured.id}
      `,
      'captured event after refused TRUNCATE',
    );
    expect(afterTruncate).toEqual(captured);

    await expect(db.unsafe(`TRUNCATE "${schema}".merchants RESTART IDENTITY CASCADE`)).rejects.toThrow(
      /TRUNCATE is not permitted/,
    );
    const afterCascade = one(
      await db<StoredEvent[]>`
        SELECT id, payment_id, event, payload->>'amount' AS amount, seq::text AS seq
          FROM payment_events
         WHERE id = ${captured.id}
      `,
      'captured event after refused CASCADE',
    );
    expect(afterCascade).toEqual(captured);

    await expect(db`
      UPDATE payment_events
         SET event = 'tampered'
       WHERE id = ${captured.id}
    `).rejects.toThrow(/UPDATE is not permitted/);

    await expect(db`
      DELETE FROM payment_events
       WHERE id = ${captured.id}
    `).rejects.toThrow(/DELETE is not permitted/);

    const stillCaptured = one(
      await db<StoredEvent[]>`
        SELECT id, payment_id, event, payload->>'amount' AS amount, seq::text AS seq
          FROM payment_events
         WHERE id = ${captured.id}
      `,
      'captured event after refused UPDATE and DELETE',
    );
    expect(stillCaptured).toEqual(captured);

    const refunded = one(
      await db<StoredEvent[]>`
        INSERT INTO payment_events (payment_id, event, payload)
        VALUES (
          ${payment.id},
          'refunded',
          jsonb_build_object('amount', ${REFUNDED}::text)
        )
        RETURNING id, payment_id, event, payload->>'amount' AS amount, seq::text AS seq
      `,
      'refunded event',
    );
    expect(refunded.event).toBe('refunded');
    expect(refunded.amount).toBe(REFUNDED);
    expect(refunded.payment_id).toBe(payment.id);

    const stored = await db<StoredEvent[]>`
      SELECT id, payment_id, event, payload->>'amount' AS amount, seq::text AS seq
        FROM payment_events
       WHERE payment_id = ${payment.id}
       ORDER BY seq::bigint
    `;
    expect(stored).toEqual([captured, refunded]);

    const triggers = await db<Array<{ proname: string; def: string }>>`
      SELECT p.proname, pg_get_triggerdef(t.oid) AS def
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE n.nspname = ${schema}
         AND c.relname = 'payment_events'
         AND NOT t.tgisinternal
       ORDER BY t.tgname
    `;
    const truncateTrigger = triggers.find((row) => row.def.includes('TRUNCATE'));
    expect(truncateTrigger?.proname).toBe('payment_events_append_only');
    expect(truncateTrigger?.def).toMatch(/BEFORE TRUNCATE/);
    expect(truncateTrigger?.def).toMatch(/FOR EACH STATEMENT/);

    const rowTrigger = triggers.find((row) => row.def.includes('UPDATE') && row.def.includes('DELETE'));
    expect(rowTrigger?.proname).toBe('payment_events_append_only');
    expect(rowTrigger?.def).toMatch(/BEFORE DELETE OR UPDATE/);
    expect(rowTrigger?.def).toMatch(/FOR EACH ROW/);

    await db.unsafe(closingDown);

    const afterDown = await db<Array<{ proname: string; def: string }>>`
      SELECT p.proname, pg_get_triggerdef(t.oid) AS def
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE n.nspname = ${schema}
         AND c.relname = 'payment_events'
         AND NOT t.tgisinternal
    `;
    expect(afterDown.filter((row) => row.def.includes('TRUNCATE'))).toEqual([]);
    expect(
      afterDown.filter((row) => row.proname === 'payment_events_append_only' && row.def.includes('FOR EACH ROW')),
    ).toHaveLength(1);

    const kept = one(
      await db<StoredEvent[]>`
        SELECT id, payment_id, event, payload->>'amount' AS amount, seq::text AS seq
          FROM payment_events
         WHERE id = ${captured.id}
      `,
      'captured event after reversal',
    );
    expect(kept).toEqual(captured);
  });
});
