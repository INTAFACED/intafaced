import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * merchant_webhook_deliveries.endpoint_id and merchant_id are independent
 * foreign keys in 0008. endpoint_id references merchant_webhook_endpoints(id)
 * and merchant_id references merchants(id). UNIQUE (endpoint_id, event_id)
 * does not require the delivery merchant to be the endpoint merchant.
 *
 * 0025 adds UNIQUE (id, merchant_id) on merchant_webhook_endpoints, then
 * FOREIGN KEY (endpoint_id, merchant_id) referencing that pair. A stored
 * mismatch makes ADD CONSTRAINT fail and leaves the row. The down file drops
 * the foreign key, then the unique constraint.
 *
 * Prior forward files are applied first, including 0024. Pay SQL is
 * schema-qualified and rewritten onto a schema in the database
 * TEST_DATABASE_URL names. This file does not start Postgres and does not
 * create a database.
 *
 * Fixture merchants, endpoints, and deliveries live only in this test.
 * The migration does not insert them.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const CLOSING = '0025_pay_webhook_delivery_merchant_match.sql';
const CLOSING_DOWN = '0025_pay_webhook_delivery_merchant_match.down.sql';

const ENDPOINT_ID_MERCHANT_UQ = 'merchant_webhook_endpoints_id_merchant_uq';
const DELIVERY_ENDPOINT_MERCHANT_FK = 'merchant_webhook_deliveries_endpoint_merchant_fk';

const FIXTURE_SIGNING_SECRET = 'l870-fixture-signing-secret';
const FIXTURE_SECRET_HASH = 'l870-fixture-secret-hash';

const priorMigrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql') && f !== CLOSING)
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error('TEST_DATABASE_URL is unset; refusing to guess a database for webhook deliveries');
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

interface StoredDelivery {
  id: string;
  endpoint_id: string;
  merchant_id: string;
  event_id: string;
}

interface ConstraintRow {
  conname: string;
  contype: string;
  def: string;
}

describe('a webhook delivery merchant matches the endpoint merchant', () => {
  let sql: postgres.Sql | undefined;
  let admin: postgres.Sql | undefined;
  let schema = '';

  beforeAll(async () => {
    const url = testDatabaseUrl();
    admin = postgres(url, { max: 1, onnotice: () => undefined });
    const current = one(await admin<Array<{ db: string }>>`SELECT current_database() AS db`, 'current database');
    if (!current.db.endsWith('_test')) {
      throw new Error(`refusing to migrate webhook deliveries on database ${current.db}`);
    }

    schema = `test_pay_l870_${process.pid}`;
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

  it('refuses a delivery whose merchant is not the endpoint merchant, stores a matching pair, and leaves an already-mismatched row when the foreign key cannot be added', async () => {
    const db = (() => {
      if (!sql) throw new Error('Native test database was not opened');
      return sql;
    })();
    if (!db || !schema) throw new Error('test database was not opened');

    const closing = rewritePaySchema(readFileSync(join(drizzleDir, CLOSING), 'utf8'), schema);
    const closingDown = rewritePaySchema(readFileSync(join(drizzleDir, CLOSING_DOWN), 'utf8'), schema);
    const statements = stripSqlComments(readFileSync(join(drizzleDir, CLOSING), 'utf8'));
    const downStatements = stripSqlComments(readFileSync(join(drizzleDir, CLOSING_DOWN), 'utf8'));

    const uniqueAt = statements.indexOf(ENDPOINT_ID_MERCHANT_UQ);
    const foreignAt = statements.indexOf(DELIVERY_ENDPOINT_MERCHANT_FK);
    expect(uniqueAt).toBeGreaterThanOrEqual(0);
    expect(foreignAt).toBeGreaterThan(uniqueAt);
    expect(statements).toMatch(new RegExp(`ADD CONSTRAINT "${ENDPOINT_ID_MERCHANT_UQ}"\\s+UNIQUE \\("id", "merchant_id"\\)`));
    expect(statements).toMatch(
      new RegExp(
        `ADD CONSTRAINT "${DELIVERY_ENDPOINT_MERCHANT_FK}"\\s+FOREIGN KEY \\("endpoint_id", "merchant_id"\\)\\s+REFERENCES "pay"\\."merchant_webhook_endpoints" \\("id", "merchant_id"\\)`,
      ),
    );
    expect(statements).not.toMatch(/\bINSERT\b/i);
    expect(statements).not.toMatch(/\bUPDATE\b/i);
    expect(statements).not.toMatch(/\bDELETE\b/i);
    expect(statements).not.toMatch(/\bTRIGGER\b/i);
    expect(statements).not.toMatch(/\bCHECK\b/i);

    const dropForeignAt = downStatements.indexOf(DELIVERY_ENDPOINT_MERCHANT_FK);
    const dropUniqueAt = downStatements.indexOf(ENDPOINT_ID_MERCHANT_UQ);
    expect(dropForeignAt).toBeGreaterThanOrEqual(0);
    expect(dropUniqueAt).toBeGreaterThan(dropForeignAt);
    expect(downStatements).not.toMatch(/\bINSERT\b/i);
    expect(downStatements).not.toMatch(/\bUPDATE\b/i);
    expect(downStatements).not.toMatch(/\bDELETE\b/i);

    const merchantA = one(
      await db<Array<{ id: string }>>`
        INSERT INTO merchants (user_id)
        VALUES ('l870-merchant-a')
        RETURNING id
      `,
      'merchant A',
    );
    const merchantB = one(
      await db<Array<{ id: string }>>`
        INSERT INTO merchants (user_id)
        VALUES ('l870-merchant-b')
        RETURNING id
      `,
      'merchant B',
    );

    const endpointId = randomUUID();
    await db`
      INSERT INTO merchant_webhook_endpoints (id, merchant_id, url, secret_hash, signing_secret)
      VALUES (
        ${endpointId},
        ${merchantA.id},
        'https://merchant.example/hooks/l870',
        ${FIXTURE_SECRET_HASH},
        ${FIXTURE_SIGNING_SECRET}
      )
    `;

    async function stored(id: string): Promise<StoredDelivery | undefined> {
      const rows = await db<StoredDelivery[]>`
        SELECT id, endpoint_id, merchant_id, event_id
          FROM merchant_webhook_deliveries
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
           AND con.conname IN (${ENDPOINT_ID_MERCHANT_UQ}, ${DELIVERY_ENDPOINT_MERCHANT_FK})
         ORDER BY con.conname
      `;
    }

    async function insertDelivery(merchantId: string, eventId: string): Promise<string> {
      const id = randomUUID();
      await db`
        INSERT INTO merchant_webhook_deliveries
          (id, endpoint_id, merchant_id, event_id, event_type, payload)
        VALUES (
          ${id},
          ${endpointId},
          ${merchantId},
          ${eventId},
          'payment.settled',
          ${db.json({ lane: 'L870' })}
        )
      `;
      return id;
    }

    async function expectMismatchRefused(eventId: string): Promise<void> {
      const id = randomUUID();
      const error = await db`
        INSERT INTO merchant_webhook_deliveries
          (id, endpoint_id, merchant_id, event_id, event_type, payload)
        VALUES (
          ${id},
          ${endpointId},
          ${merchantB.id},
          ${eventId},
          'payment.settled',
          ${db.json({ lane: 'L870' })}
        )
      `.then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).toMatchObject({ code: '23503' });
      expect(String((error as { message?: string }).message)).toContain(DELIVERY_ENDPOINT_MERCHANT_FK);
      expect(await stored(id)).toBeUndefined();
    }

    const mismatchedId = await insertDelivery(merchantB.id, 'l870-already-mismatched');
    const mismatchedBefore = one(
      await db<StoredDelivery[]>`
        SELECT id, endpoint_id, merchant_id, event_id
          FROM merchant_webhook_deliveries
         WHERE id = ${mismatchedId}
      `,
      'mismatched delivery before the foreign key',
    );
    expect(mismatchedBefore.endpoint_id).toBe(endpointId);
    expect(mismatchedBefore.merchant_id).toBe(merchantB.id);

    const addError = await db.unsafe(closing).then(
      () => null,
      (err: unknown) => err,
    );
    expect(addError).toMatchObject({ code: '23503' });
    expect(String((addError as { message?: string }).message)).toContain(DELIVERY_ENDPOINT_MERCHANT_FK);
    const mismatchedAfter = one(
      await db<StoredDelivery[]>`
        SELECT id, endpoint_id, merchant_id, event_id
          FROM merchant_webhook_deliveries
         WHERE id = ${mismatchedId}
      `,
      'mismatched delivery after the refused foreign key',
    );
    expect(mismatchedAfter).toEqual(mismatchedBefore);
    expect(await constraints()).toEqual([]);
    await db`DELETE FROM merchant_webhook_deliveries WHERE id = ${mismatchedId}`;

    await db.unsafe(closing);
    expect(await constraints()).toEqual([
      {
        conname: DELIVERY_ENDPOINT_MERCHANT_FK,
        contype: 'f',
        def: 'FOREIGN KEY (endpoint_id, merchant_id) REFERENCES merchant_webhook_endpoints(id, merchant_id)',
      },
      {
        conname: ENDPOINT_ID_MERCHANT_UQ,
        contype: 'u',
        def: 'UNIQUE (id, merchant_id)',
      },
    ]);

    await expectMismatchRefused('l870-refused-mismatch');

    const matchedId = await insertDelivery(merchantA.id, 'l870-matched');
    const matched = one(
      await db<StoredDelivery[]>`
        SELECT id, endpoint_id, merchant_id, event_id
          FROM merchant_webhook_deliveries
         WHERE id = ${matchedId}
      `,
      'matching delivery',
    );
    expect(matched.endpoint_id).toBe(endpointId);
    expect(matched.merchant_id).toBe(merchantA.id);
    expect(matched.event_id).toBe('l870-matched');

    const updateError = await db`
      UPDATE merchant_webhook_deliveries
         SET merchant_id = ${merchantB.id}
       WHERE id = ${matchedId}
    `.then(
      () => null,
      (err: unknown) => err,
    );
    expect(updateError).toMatchObject({ code: '23503' });
    expect(String((updateError as { message?: string }).message)).toContain(DELIVERY_ENDPOINT_MERCHANT_FK);
    const afterUpdate = one(
      await db<StoredDelivery[]>`
        SELECT id, endpoint_id, merchant_id, event_id
          FROM merchant_webhook_deliveries
         WHERE id = ${matchedId}
      `,
      'matching delivery after the refused merchant change',
    );
    expect(afterUpdate).toEqual(matched);

    await db.unsafe(closingDown);
    expect(await constraints()).toEqual([]);
    const afterDown = one(
      await db<StoredDelivery[]>`
        SELECT id, endpoint_id, merchant_id, event_id
          FROM merchant_webhook_deliveries
         WHERE id = ${matchedId}
      `,
      'matching delivery after reversal',
    );
    expect(afterDown).toEqual(matched);
  });
});
