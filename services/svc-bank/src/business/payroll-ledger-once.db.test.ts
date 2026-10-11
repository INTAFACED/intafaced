/**
 * L1129. business_payroll_runs.ledger_tx_id is text NOT NULL, but a blank
 * string still stores and the same house-ledger post can be recorded twice.
 *
 * An empty id is a check violation (23514). A second run with the same
 * ledger_tx_id is a unique violation (23505). Two different non-empty ids
 * both store. A run insert alone is enough; no line and no ledger post.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';

const adminUrl = process.env.TEST_DATABASE_URL;
if (adminUrl === undefined || adminUrl.trim() === '') {
  throw new Error('TEST_DATABASE_URL is unset');
}

const adminDatabase = decodeURIComponent(new URL(adminUrl).pathname.replace(/^\//, ''));
if (adminDatabase === '' || adminDatabase === 'postgres') {
  throw new Error('refusing to connect to a database named postgres');
}

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const ASSET = 'USDT';
const THRESHOLD = '1';
const ACTOR = 'l1129-actor';
const FROM_SPACE = '11111111-1111-4111-8111-111111111111';
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const RUN_BLANK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const RUN_SAME_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const RUN_SAME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const RUN_DIFF_A = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const RUN_DIFF_B = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
const LEDGER_SAME = 'ledger-tx-same';
const LEDGER_A = 'ledger-tx-a';
const LEDGER_B = 'ledger-tx-b';

let db: TestDatabase | undefined;
let accountId: string;

beforeAll(async () => {
  db = await createTestDatabase({ service: 'bank', url: adminUrl, migrations: MIGRATIONS });
  const rows = await db.sql<Array<{ id: string }>>`
    INSERT INTO bank.business_accounts (name, asset_id, spend_threshold)
    VALUES (${'l1129'}, ${ASSET}, ${THRESHOLD}::numeric)
    RETURNING id::text AS id
  `;
  accountId = rows[0]!.id;
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

async function insertRun(id: string, ledgerTxId: string): Promise<Array<{ id: string }>> {
  return db!.sql<Array<{ id: string }>>`
    INSERT INTO bank.business_payroll_runs (
      id, account_id, actor_user_id, from_space_id, asset_id, ledger_tx_id
    ) VALUES (
      ${id}::uuid,
      ${accountId}::uuid,
      ${ACTOR},
      ${FROM_SPACE}::uuid,
      ${ASSET},
      ${ledgerTxId}
    )
    RETURNING id::text AS id
  `;
}

describe('a payroll run cannot reuse or blank its ledger post', () => {
  it('runs in the per-run bank database, not the admin database', async () => {
    expect(db!.database).toMatch(/^itf_run_bank_.*_test$/);
    expect(db!.database).not.toBe('intafaced_test');
    expect(db!.database).not.toBe('postgres');
    const rows = await db!.sql<Array<{ name: string }>>`SELECT current_database() AS name`;
    expect(rows[0]!.name).toBe(db!.database);
    console.log(`sql target ${db!.database}`);
  });

  it('refuses a blank ledger_tx_id', async () => {
    await expect(insertRun(RUN_BLANK, '')).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('refuses a second run that reuses a ledger_tx_id', async () => {
    const first = await insertRun(RUN_SAME_A, LEDGER_SAME);
    expect(first).toHaveLength(1);
    await expect(insertRun(RUN_SAME_B, LEDGER_SAME)).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
  });

  it('inserts two runs with different ledger posts', async () => {
    const first = await insertRun(RUN_DIFF_A, LEDGER_A);
    const second = await insertRun(RUN_DIFF_B, LEDGER_B);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]!.id).toBe(RUN_DIFF_A);
    expect(second[0]!.id).toBe(RUN_DIFF_B);
  });
});
