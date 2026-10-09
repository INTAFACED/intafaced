import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * merchant_webhook_endpoints.signing_secret is the raw HMAC key. 0008 stores
 * it and secret_hash as text NOT NULL, which still admits '' and a string of
 * spaces. 0024 adds CHECK (length(btrim(column)) > 0) on each column.
 *
 * Prior forward files are applied first. Pay SQL is schema-qualified and
 * rewritten onto a schema in the database TEST_DATABASE_URL names. This file
 * does not start Postgres and does not create a database.
 *
 * The fixture secret lives only in this test. The migration does not invent one.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const CLOSING = '0024_pay_webhook_secret_not_blank.sql';
const CLOSING_DOWN = '0024_pay_webhook_secret_not_blank.down.sql';

const SIGNING_SECRET_CK = 'merchant_webhook_endpoints_signing_secret_not_blank';
const SECRET_HASH_CK = 'merchant_webhook_endpoints_secret_hash_not_blank';

/** Space-only. btrim removes spaces, so this is blank for the check. */
const SPACES = '   ';

const FIXTURE_SIGNING_SECRET = 'l869-fixture-signing-secret';
const FIXTURE_SECRET_HASH = 'l869-fixture-secret-hash';

const priorMigrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql') && f !== CLOSING)
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error('TEST_DATABASE_URL is unset; refusing to guess a database for webhook secrets');
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

interface StoredSecret {
  id: string;
  signing_secret: string;
  secret_hash: string;
}

describe('merchant webhook signing_secret and secret_hash are non-blank', () => {
  let sql: postgres.Sql | undefined;
  let admin: postgres.Sql | undefined;
  let schema = '';

  beforeAll(async () => {
    const url = testDatabaseUrl();
    admin = postgres(url, { max: 1, onnotice: () => undefined });
    const current = one(await admin<Array<{ db: string }>>`SELECT current_database() AS db`, 'current database');
    if (!current.db.endsWith('_test')) {
      throw new Error(`refusing to migrate webhook secrets on database ${current.db}`);
    }

    schema = `test_pay_l869_${process.pid}`;
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

  it('refuses an empty or space-only secret, stores a non-blank pair, and leaves an already-blank row when the check cannot be added', async () => {
    const db = sql;
    if (!db || !schema) throw new Error('test database was not opened');

    const closing = rewritePaySchema(readFileSync(join(drizzleDir, CLOSING), 'utf8'), schema);
    const closingDown = rewritePaySchema(readFileSync(join(drizzleDir, CLOSING_DOWN), 'utf8'), schema);
    const statements = stripSqlComments(readFileSync(join(drizzleDir, CLOSING), 'utf8'));
    expect(statements).toMatch(/length\(btrim\("signing_secret"\)\)\s*>\s*0/);
    expect(statements).toMatch(/length\(btrim\("secret_hash"\)\)\s*>\s*0/);
    expect(statements).not.toMatch(/\bINSERT\b/i);
    expect(statements).not.toMatch(/\bUPDATE\b/i);
    expect(statements).not.toMatch(/\bDELETE\b/i);

    const merchant = one(
      await db<Array<{ id: string }>>`
        INSERT INTO merchants (user_id)
        VALUES ('l869-webhook-secret')
        RETURNING id
      `,
      'merchant',
    );

    async function insertEndpoint(signingSecret: string, secretHash: string): Promise<string> {
      const id = randomUUID();
      await db`
        INSERT INTO merchant_webhook_endpoints (id, merchant_id, url, secret_hash, signing_secret)
        VALUES (
          ${id},
          ${merchant.id},
          'https://merchant.example/hooks/l869',
          ${secretHash},
          ${signingSecret}
        )
      `;
      return id;
    }

    async function stored(id: string): Promise<StoredSecret | undefined> {
      const rows = await db<StoredSecret[]>`
        SELECT id, signing_secret, secret_hash
          FROM merchant_webhook_endpoints
         WHERE id = ${id}
      `;
      return rows[0];
    }

    async function checkNames(): Promise<string[]> {
      const rows = await db<Array<{ conname: string }>>`
        SELECT con.conname
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ${schema}
           AND c.relname = 'merchant_webhook_endpoints'
           AND con.contype = 'c'
         ORDER BY con.conname
      `;
      return rows.map((row) => row.conname);
    }

    async function expectRefused(signingSecret: string, secretHash: string, constraint: string): Promise<void> {
      const id = randomUUID();
      const error = await db`
        INSERT INTO merchant_webhook_endpoints (id, merchant_id, url, secret_hash, signing_secret)
        VALUES (
          ${id},
          ${merchant.id},
          'https://merchant.example/hooks/l869',
          ${secretHash},
          ${signingSecret}
        )
      `.then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).toMatchObject({ code: '23514' });
      expect(String((error as { message?: string }).message)).toContain(constraint);
      expect(await stored(id)).toBeUndefined();
    }

    const blankSecretId = await insertEndpoint('', FIXTURE_SECRET_HASH);
    const blankSecretBefore = one(await db<StoredSecret[]>`
      SELECT id, signing_secret, secret_hash
        FROM merchant_webhook_endpoints
       WHERE id = ${blankSecretId}
    `, 'blank signing_secret before the check');
    expect(blankSecretBefore.signing_secret).toBe('');
    await expect(db.unsafe(closing)).rejects.toThrow(new RegExp(SIGNING_SECRET_CK));
    const blankSecretAfter = one(await db<StoredSecret[]>`
      SELECT id, signing_secret, secret_hash
        FROM merchant_webhook_endpoints
       WHERE id = ${blankSecretId}
    `, 'blank signing_secret after the refused check');
    expect(blankSecretAfter).toEqual(blankSecretBefore);
    expect(await checkNames()).toEqual([]);
    await db`DELETE FROM merchant_webhook_endpoints WHERE id = ${blankSecretId}`;

    const blankHashId = await insertEndpoint(FIXTURE_SIGNING_SECRET, SPACES);
    const blankHashBefore = one(await db<StoredSecret[]>`
      SELECT id, signing_secret, secret_hash
        FROM merchant_webhook_endpoints
       WHERE id = ${blankHashId}
    `, 'blank secret_hash before the check');
    expect(blankHashBefore.secret_hash).toBe(SPACES);
    await expect(db.unsafe(closing)).rejects.toThrow(new RegExp(SECRET_HASH_CK));
    const blankHashAfter = one(await db<StoredSecret[]>`
      SELECT id, signing_secret, secret_hash
        FROM merchant_webhook_endpoints
       WHERE id = ${blankHashId}
    `, 'blank secret_hash after the refused check');
    expect(blankHashAfter).toEqual(blankHashBefore);
    expect(await checkNames()).toEqual([]);
    await db`DELETE FROM merchant_webhook_endpoints WHERE id = ${blankHashId}`;

    await db.unsafe(closing);
    expect(await checkNames()).toEqual([SECRET_HASH_CK, SIGNING_SECRET_CK]);

    await expectRefused('', FIXTURE_SECRET_HASH, SIGNING_SECRET_CK);
    await expectRefused(SPACES, FIXTURE_SECRET_HASH, SIGNING_SECRET_CK);
    await expectRefused(FIXTURE_SIGNING_SECRET, '', SECRET_HASH_CK);
    await expectRefused(FIXTURE_SIGNING_SECRET, SPACES, SECRET_HASH_CK);

    const storedId = await insertEndpoint(FIXTURE_SIGNING_SECRET, FIXTURE_SECRET_HASH);
    const pair = one(await db<StoredSecret[]>`
      SELECT id, signing_secret, secret_hash
        FROM merchant_webhook_endpoints
       WHERE id = ${storedId}
    `, 'non-blank pair');
    expect(pair.signing_secret).toBe(FIXTURE_SIGNING_SECRET);
    expect(pair.secret_hash).toBe(FIXTURE_SECRET_HASH);

    await db.unsafe(closingDown);
    expect(await checkNames()).toEqual([]);
    const afterDown = one(await db<StoredSecret[]>`
      SELECT id, signing_secret, secret_hash
        FROM merchant_webhook_endpoints
       WHERE id = ${storedId}
    `, 'non-blank pair after reversal');
    expect(afterDown).toEqual(pair);
  });
});
