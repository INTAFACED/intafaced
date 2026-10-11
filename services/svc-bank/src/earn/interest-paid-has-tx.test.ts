/**
 * A paid interest accrual must name the house-ledger transaction.
 *
 * `interest_accruals_consistent_ck` in 0000 allows paid_amount > 0 and
 * recipients > 0 with ledger_tx_id null. A settled transfer in the same file
 * cannot. This test applies every forward migration except
 * 0017_interest_accrual_paid_has_tx, records that the old shape is accepted,
 * then applies that migration and requires the next paid-without-tx insert
 * to be rejected. The stored row is left as it was.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { afterAll, describe, expect, it } from 'vitest';

const FORWARD = '0017_interest_accrual_paid_has_tx.sql';
const PAID_AMOUNT = '1.5';
const RATE_BPS = '3650';
const RECIPIENTS = 2;

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const forwardFiles = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort();
const prior = forwardFiles.filter((file) => file !== FORWARD).map((file) => readFileSync(join(drizzle, file), 'utf8'));
const forwardPath = join(drizzle, FORWARD);
const forward = forwardFiles.includes(FORWARD) ? readFileSync(forwardPath, 'utf8') : null;

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://Nitro@127.0.0.1:5432/intafaced_test';
const available = await postgresAvailable(databaseUrl);
if (!available) {
  throw new Error(`Postgres test database is not available at ${databaseUrl}`);
}

const db: TestDatabase = await createTestDatabase({ service: 'bank', url: databaseUrl, migrations: prior });
const sql = db.sql;

afterAll(async () => {
  await db.drop();
}, 30_000);

async function insertPool(): Promise<string> {
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO bank.earn_pools (asset_id, kind, name, apr_bps, min_deposit)
    VALUES ('USDT', 'flexible', 'USDT flexible', ${RATE_BPS}::numeric, ${'0'}::numeric)
    RETURNING id
  `;
  return rows[0]!.id;
}

function insertPaidWithoutLedgerTx(poolId: string, accrualDate: string) {
  return sql<Array<{ id: string; recipients: number; ledger_tx_id: string | null }>>`
    INSERT INTO bank.interest_accruals (
      pool_id, accrual_date, rate_bps, paid_amount, recipients, ledger_tx_id
    ) VALUES (
      ${poolId},
      ${accrualDate},
      ${RATE_BPS}::numeric,
      ${PAID_AMOUNT}::numeric,
      ${RECIPIENTS},
      NULL
    )
    RETURNING id, recipients, ledger_tx_id
  `;
}

describe('interest accrual paid without a house-ledger transaction', () => {
  it('accepts the paid row before 0017 and rejects the same shape after it', async () => {
    const poolId = await insertPool();

    const stored = await insertPaidWithoutLedgerTx(poolId, '2026-03-01');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ recipients: RECIPIENTS, ledger_tx_id: null });

    if (forward) await sql.unsafe(forward);

    await expect(
      insertPaidWithoutLedgerTx(poolId, '2026-03-02'),
      'a paid accrual with recipients > 0 and ledger_tx_id null must be rejected',
    ).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'interest_accruals_consistent_ck',
    });

    const kept = await sql<Array<{ ledger_tx_id: string | null; recipients: number; amount_unchanged: boolean }>>`
      SELECT ledger_tx_id,
             recipients,
             (paid_amount = ${PAID_AMOUNT}::numeric) AS amount_unchanged
        FROM bank.interest_accruals
       WHERE id = ${stored[0]!.id}
    `;
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ ledger_tx_id: null, recipients: RECIPIENTS, amount_unchanged: true });
  }, 30_000);
});
