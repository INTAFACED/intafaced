/**
 * Settled loan movements must point at a ledger transaction.
 *
 * The same shape as `transfer_executions_settled_has_tx_ck` in the initial
 * bank schema: `pending` may exist before the post, and `settled` may not
 * exist without a transaction id and a settled_at. A liquidation whose
 * shortfall above zero is bad debt, so the row may not exist without
 * `bad_debt_ledger_tx_id`.
 *
 * Raw SQL. The guard is worthless if only the TypeScript path is checked.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const CHECK_VIOLATION = '23514';

const db: TestDatabase = await createTestDatabase({ service: 'bank', url: URL, migrations: MIGRATIONS });

afterAll(async () => {
  await db.drop();
});

async function seedLoan(): Promise<string> {
  const [product] = await db.sql<Array<{ id: string }>>`
    INSERT INTO bank.loan_products (
      name, debt_asset_id, collateral_asset_id, quote_asset_id,
      apr_bps, max_ltv_bps, margin_call_ltv_bps, liquidation_ltv_bps,
      insolvency_ltv_bps, target_ltv_bps, penalty_bps, max_tranche_bps, grace_seconds
    ) VALUES (
      'probe', 'USDT', 'BTC', 'USDT',
      1000, 5000, 7500, 8500,
      9500, 6500, 200, 2500, 3600
    )
    RETURNING id
  `;
  const [loan] = await db.sql<Array<{ id: string }>>`
    INSERT INTO bank.loans (
      product_id, user_id, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps, principal
    ) VALUES (
      ${product!.id}, '11111111-1111-4111-8111-111111111111', 'USDT', 'BTC', 'USDT', 1000, '1'::numeric
    )
    RETURNING id
  `;
  return loan!.id;
}

describe('settled loan rows require a ledger tx', () => {
  it('refuses a settled collateral event with a null ledger tx', async () => {
    const loanId = await seedLoan();
    await expect(
      db.sql`
        INSERT INTO bank.loan_collateral_events (loan_id, sequence, direction, amount, status, settled_at)
        VALUES (${loanId}, 0, 'lock', '1'::numeric, 'settled', now())
      `,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('refuses a settled repayment with a null ledger tx', async () => {
    const loanId = await seedLoan();
    await expect(
      db.sql`
        INSERT INTO bank.loan_repayments (
          loan_id, sequence, interest_amount, principal_amount, status, settled_at
        ) VALUES (
          ${loanId}, 0, '0'::numeric, '1'::numeric, 'settled', now()
        )
      `,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('refuses a settled liquidation with a null ledger tx', async () => {
    const loanId = await seedLoan();
    await expect(
      db.sql`
        INSERT INTO bank.loan_liquidations (
          loan_id, tranche, ltv_bps, mark_price, collateral_sold, proceeds,
          principal_repaid, interest_repaid, penalty, surplus_returned, shortfall,
          status, settled_at
        ) VALUES (
          ${loanId}, 0, 8500, '1'::numeric, '1'::numeric, '1'::numeric,
          '1'::numeric, '0'::numeric, '0'::numeric, '0'::numeric, '0'::numeric,
          'settled', now()
        )
      `,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('refuses settled without settled_at, matching a settled transfer', async () => {
    const loanId = await seedLoan();
    await expect(
      db.sql`
        INSERT INTO bank.loan_collateral_events (
          loan_id, sequence, direction, amount, status, ledger_tx_id
        ) VALUES (
          ${loanId}, 0, 'lock', '1'::numeric, 'settled', 'ledger-tx-probe'
        )
      `,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('refuses a liquidation whose shortfall is above zero without a bad-debt ledger tx', async () => {
    const loanId = await seedLoan();
    await expect(
      db.sql`
        INSERT INTO bank.loan_liquidations (
          loan_id, tranche, ltv_bps, mark_price, collateral_sold, proceeds,
          principal_repaid, interest_repaid, penalty, surplus_returned, shortfall,
          status, ledger_tx_id, settled_at
        ) VALUES (
          ${loanId}, 0, 8500, '1'::numeric, '1'::numeric, '1'::numeric,
          '1'::numeric, '0'::numeric, '0'::numeric, '0'::numeric, '1'::numeric,
          'settled', 'ledger-tx-probe', now()
        )
      `,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('refuses shortfall above zero on a row that is not yet settled', async () => {
    const loanId = await seedLoan();
    await expect(
      db.sql`
        INSERT INTO bank.loan_liquidations (
          loan_id, tranche, ltv_bps, mark_price, collateral_sold, proceeds,
          principal_repaid, interest_repaid, penalty, surplus_returned, shortfall
        ) VALUES (
          ${loanId}, 0, 8500, '1'::numeric, '1'::numeric, '1'::numeric,
          '1'::numeric, '0'::numeric, '0'::numeric, '0'::numeric, '1'::numeric
        )
      `,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('accepts a settled collateral event that names its ledger tx', async () => {
    const loanId = await seedLoan();
    const rows = await db.sql<Array<{ id: string }>>`
      INSERT INTO bank.loan_collateral_events (
        loan_id, sequence, direction, amount, status, ledger_tx_id, settled_at
      ) VALUES (
        ${loanId}, 0, 'lock', '1'::numeric, 'settled', 'ledger-tx-probe', now()
      )
      RETURNING id
    `;
    expect(rows).toHaveLength(1);
  });

  it('accepts a settled liquidation with no shortfall and no bad-debt tx', async () => {
    const loanId = await seedLoan();
    const rows = await db.sql<Array<{ id: string }>>`
      INSERT INTO bank.loan_liquidations (
        loan_id, tranche, ltv_bps, mark_price, collateral_sold, proceeds,
        principal_repaid, interest_repaid, penalty, surplus_returned, shortfall,
        status, ledger_tx_id, settled_at
      ) VALUES (
        ${loanId}, 0, 8500, '1'::numeric, '1'::numeric, '1'::numeric,
        '1'::numeric, '0'::numeric, '0'::numeric, '0'::numeric, '0'::numeric,
        'settled', 'ledger-tx-probe', now()
      )
      RETURNING id
    `;
    expect(rows).toHaveLength(1);
  });

  it('accepts a liquidation whose shortfall above zero names the bad-debt tx', async () => {
    const loanId = await seedLoan();
    const rows = await db.sql<Array<{ id: string }>>`
      INSERT INTO bank.loan_liquidations (
        loan_id, tranche, ltv_bps, mark_price, collateral_sold, proceeds,
        principal_repaid, interest_repaid, penalty, surplus_returned, shortfall,
        bad_debt_ledger_tx_id
      ) VALUES (
        ${loanId}, 0, 8500, '1'::numeric, '1'::numeric, '1'::numeric,
        '1'::numeric, '0'::numeric, '0'::numeric, '0'::numeric, '1'::numeric,
        'bad-debt-tx-probe'
      )
      RETURNING id
    `;
    expect(rows).toHaveLength(1);
  });
});
