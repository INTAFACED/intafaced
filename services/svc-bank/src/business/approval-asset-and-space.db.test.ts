/**
 * L1127. business_approvals.asset_id is not constrained to the referenced
 * business account asset, and from_space_id may equal to_space_id. A row can
 * instruct a different asset or a same-space move.
 *
 * A different asset is a foreign-key violation (23503). The same space on
 * both sides is a check violation (23514). The account asset with two
 * different spaces stores. Amounts stay decimal strings.
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
const OTHER_ASSET = 'BTC';
const THRESHOLD = '1';
const AMOUNT = '1';
const FROM_SPACE = '11111111-1111-4111-8111-111111111111';
const TO_SPACE = '22222222-2222-4222-8222-222222222222';
const FK_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

let db: TestDatabase | undefined;
let accountId: string;

beforeAll(async () => {
  db = await createTestDatabase({ service: 'bank', url: adminUrl, migrations: MIGRATIONS });
  const rows = await db.sql<Array<{ id: string }>>`
    INSERT INTO bank.business_accounts (name, asset_id, spend_threshold)
    VALUES (${'l1127'}, ${ASSET}, ${THRESHOLD}::numeric)
    RETURNING id::text AS id
  `;
  accountId = rows[0]!.id;
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

async function insertApproval(assetId: string, fromSpaceId: string, toSpaceId: string): Promise<Array<{ id: string }>> {
  return db!.sql<Array<{ id: string }>>`
    INSERT INTO bank.business_approvals (
      account_id, maker_user_id, from_space_id, to_space_id, asset_id, amount, status
    ) VALUES (
      ${accountId}::uuid,
      ${'l1127-maker'},
      ${fromSpaceId}::uuid,
      ${toSpaceId}::uuid,
      ${assetId},
      ${AMOUNT}::numeric,
      ${'pending'}::bank.business_approval_status
    )
    RETURNING id::text AS id
  `;
}

describe('a business approval keeps the account asset and changes space', () => {
  it('runs in the per-run bank database, not the admin database', async () => {
    expect(db!.database).toMatch(/^itf_run_bank_.*_test$/);
    expect(db!.database).not.toBe('intafaced_test');
    expect(db!.database).not.toBe('postgres');
    const rows = await db!.sql<Array<{ name: string }>>`SELECT current_database() AS name`;
    expect(rows[0]!.name).toBe(db!.database);
    console.log(`sql target ${db!.database}`);
  });

  it('refuses an approval whose asset is not the account asset', async () => {
    await expect(insertApproval(OTHER_ASSET, FROM_SPACE, TO_SPACE)).rejects.toMatchObject({
      code: FK_VIOLATION,
    });
  });

  it('refuses an approval that stays in one space', async () => {
    await expect(insertApproval(ASSET, FROM_SPACE, FROM_SPACE)).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
  });

  it('inserts an approval for the account asset across two spaces', async () => {
    const rows = await insertApproval(ASSET, FROM_SPACE, TO_SPACE);
    expect(rows).toHaveLength(1);
    expect(typeof rows[0]!.id).toBe('string');
    expect(rows[0]!.id.length).toBeGreaterThan(0);
  });
});
