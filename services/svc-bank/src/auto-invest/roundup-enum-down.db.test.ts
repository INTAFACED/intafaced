/**
 * L1128. 0014 up adds auto_invest_kind label card_roundup. The down was
 * SELECT 1, so rolling 0014 back left that label in place.
 *
 * After 0015 down, then 0014 down, pg_enum lists only threshold_sweep and
 * dca. Inserting card_roundup fails. A threshold_sweep row in the 0010
 * shape still stores. Amounts stay decimal strings.
 *
 * 0014 down alone, while a card_roundup row from the 0015 shape still
 * exists, must fail. It must not succeed and leave the label.
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

const DOWN_0014 = readFileSync(join(drizzle, '0014_auto_invest_roundup.down.sql'), 'utf8');
const DOWN_0015 = readFileSync(join(drizzle, '0015_auto_invest_roundup_shape.down.sql'), 'utf8');

const ASSET = 'USDT';
const AMOUNT = '1';
const THRESHOLD = '1';
const POOL = '33333333-3333-4333-8333-333333333333';
const INVALID_TEXT = '22P02';

let db: TestDatabase | undefined;

beforeAll(async () => {
  db = await createTestDatabase({ service: 'bank', url: adminUrl, migrations: MIGRATIONS });
}, 120_000);

afterAll(async () => {
  await db?.drop();
}, 60_000);

async function kindLabels(): Promise<string[]> {
  const rows = await db!.sql<Array<{ enumlabel: string }>>`
    SELECT e.enumlabel
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'bank'
      AND t.typname = 'auto_invest_kind'
    ORDER BY e.enumsortorder
  `;
  return rows.map((row) => row.enumlabel);
}

function insertRoundup(): Promise<Array<{ id: string }>> {
  return db!.sql<Array<{ id: string }>>`
    INSERT INTO bank.auto_invest_rules (user_id, kind, asset_id, amount, target_pool_id)
    VALUES (
      ${'l1128-roundup'},
      ${'card_roundup'}::bank.auto_invest_kind,
      ${ASSET},
      ${AMOUNT}::numeric,
      ${POOL}::uuid
    )
    RETURNING id::text AS id
  `;
}

describe.sequential('rolling back 0014 removes the card_roundup enum label', () => {
  it('runs in the per-run bank database, not the admin database', async () => {
    expect(db!.database).toMatch(/^itf_run_bank_.*_test$/);
    expect(db!.database).not.toBe('intafaced_test');
    expect(db!.database).not.toBe('postgres');
    const rows = await db!.sql<Array<{ name: string }>>`SELECT current_database() AS name`;
    expect(rows[0]!.name).toBe(db!.database);
    console.log(`sql target ${db!.database}`);
  });

  it('does not succeed and leave card_roundup when a round-up row still exists', async () => {
    const inserted = await insertRoundup();
    expect(inserted).toHaveLength(1);

    let succeeded = false;
    try {
      await db!.sql.unsafe(DOWN_0014);
      succeeded = true;
    } catch {
      succeeded = false;
    }

    const labels = await kindLabels();
    expect(succeeded && labels.includes('card_roundup')).toBe(false);
    expect(succeeded).toBe(false);
  });

  it('keeps only threshold_sweep and dca after 0015 down then 0014 down', async () => {
    await db!.sql.unsafe(DOWN_0015);
    await db!.sql.unsafe(DOWN_0014);

    expect(await kindLabels()).toEqual(['threshold_sweep', 'dca']);

    // Not insertRoundup(): that statement was prepared against the old enum OID.
    await expect(
      db!.sql.unsafe(`
        INSERT INTO bank.auto_invest_rules (user_id, kind, asset_id, amount, target_pool_id)
        VALUES (
          'l1128-roundup-after',
          'card_roundup'::"bank"."auto_invest_kind",
          '${ASSET}',
          '${AMOUNT}'::numeric,
          '${POOL}'::uuid
        )
      `),
    ).rejects.toMatchObject({ code: INVALID_TEXT });

    const stored = await db!.sql<Array<{ kind: string; threshold_is_one: boolean }>>`
      INSERT INTO bank.auto_invest_rules (user_id, kind, asset_id, threshold, target_pool_id)
      VALUES (
        ${'l1128-sweep'},
        ${'threshold_sweep'}::bank.auto_invest_kind,
        ${ASSET},
        ${THRESHOLD}::numeric,
        ${POOL}::uuid
      )
      RETURNING kind::text AS kind, (threshold = ${THRESHOLD}::numeric) AS threshold_is_one
    `;
    expect(stored).toEqual([{ kind: 'threshold_sweep', threshold_is_one: true }]);
  });
});
