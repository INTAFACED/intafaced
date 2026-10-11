import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';

/**
 * `ledger_tx_outbox_amount_string_ck` must refuse a payload with no `entries`
 * key, and an entry whose `amount` is a JSON number.
 *
 * A missing key makes `payload->'entries'` NULL. `jsonb_typeof` of NULL is
 * NULL, and CHECK treats UNKNOWN as success, so `{}` is stored. A number
 * amount is stored too. Either row holds `tx_id` on the unique index, so the
 * honest decimal-string outbox row for that transaction cannot land.
 *
 * Raw SQL. Ledger-client is not on this path. No skip-green.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');

const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema));

const CHECK_VIOLATION = '23514';
const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: svc-ledger outbox-amount-string is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('ledger_tx_outbox_amount_string_ck — entries present, amount a decimal string', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });

  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDb({ service: 'ledger_outbox_amt', url: admin.url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('refuses {} and a JSON number amount, then stores the decimal string for that tx_id', async () => {
    if (!db) throw new Error('H8a: test db not opened');
    const [tx] = await db.sql<Array<{ id: string }>>`
      INSERT INTO ledger_tx (idempotency_key, module, reason, hash)
      VALUES ('l57outbox', 'test', 'outbox amount string', 'h-l57-outbox')
      RETURNING id
    `;
    const txId = tx!.id;
    const insertPayload = (payload: string, correlationId: string) =>
      db!.sql`
        INSERT INTO ledger_tx_outbox (tx_id, payload, correlation_id)
        VALUES (${txId}, ${db!.sql.json(JSON.parse(payload))}, ${correlationId})
      `;

    await expect(insertPayload('{}', 'l57-empty')).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insertPayload('{"entries":[{"amount":1}]}', 'l57-number')).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    await expect(insertPayload('{"entries":[{"amount":"1"}]}', 'l57-string')).resolves.toBeDefined();

    const rows = await db.sql<Array<{ n: string }>>`
      SELECT count(*) AS n FROM ledger_tx_outbox WHERE tx_id = ${txId}
    `;
    expect(Number(rows[0]!.n)).toBe(1);
  });
});
