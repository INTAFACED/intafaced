/**
 * loan_interest_non_negative allows interest_amount > 0 when principal_basis
 * is 0, so a daily accrual row can capitalise interest on no debt.
 *
 * 0002 stays as applied. 0023 refuses a new accrual that charges interest on a
 * zero principal basis. A zero charge on a zero basis still stores. A positive
 * basis with a positive charge still stores. A positive basis with a zero
 * charge still stores. A negative interest amount or a negative principal basis
 * stays refused. Stored rows are not rewritten. The fixture, including the down
 * migration, runs in a transaction and rolls back.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.TEST_DATABASE_URL;
if (!URL) throw new Error('TEST_DATABASE_URL is unset');

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');

const ZERO = '0';
const CHARGE = '1.25';
const BASIS = '5000';
const NEGATIVE = '-1';
const LOAN_PRINCIPAL = '100';
const RATE_BPS = 1000;

type Tx = postgres.TransactionSql;

interface AccrualRow {
  id: string;
  accrual_date: string;
  principal_basis: string;
  interest_amount: string;
}

interface StoredAccrual extends AccrualRow {
  principal_matches: boolean;
  interest_matches: boolean;
}

class RollBack extends Error {
  constructor() {
    super('roll back loan-interest fixture');
  }
}

function sqlFiles(): string[] {
  return readdirSync(drizzleDir)
    .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
    .sort();
}

function migrationPair(): { up: string; down: string } {
  const names = readdirSync(drizzleDir);
  const up = names.find((name) => /^0023_.*\.sql$/.test(name) && !name.endsWith('.down.sql'));
  const down = names.find((name) => /^0023_.*\.down\.sql$/.test(name));
  return { up: up ? readFileSync(join(drizzleDir, up), 'utf8') : '', down: down ? readFileSync(join(drizzleDir, down), 'utf8') : '' };
}

let sql: postgres.Sql;

beforeAll(async () => {
  sql = postgres(URL, { max: 1, onnotice: () => undefined });
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS bank');
  await sql`
    CREATE TABLE IF NOT EXISTS bank.__migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  const applied = new Set((await sql<Array<{ name: string }>>`SELECT name FROM bank.__migrations`).map((row) => row.name));
  for (const file of sqlFiles()) {
    if (applied.has(file)) continue;
    await sql.unsafe(readFileSync(join(drizzleDir, file), 'utf8'));
    await sql`INSERT INTO bank.__migrations (name) VALUES (${file})`;
  }
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

async function accruals(tx: Tx, loanId: string): Promise<AccrualRow[]> {
  return tx<AccrualRow[]>`
    SELECT id::text AS id,
           accrual_date::text AS accrual_date,
           principal_basis::text AS principal_basis,
           interest_amount::text AS interest_amount
      FROM bank.loan_interest_accruals
     WHERE loan_id = ${loanId}
     ORDER BY accrual_date
  `;
}

async function openLoan(tx: Tx): Promise<string> {
  const products = await tx<Array<{ id: string }>>`
    INSERT INTO bank.loan_products (
      name, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps, max_ltv_bps,
      margin_call_ltv_bps, liquidation_ltv_bps, insolvency_ltv_bps, target_ltv_bps,
      penalty_bps, max_tranche_bps, grace_seconds
    ) VALUES (
      ${'l1103-product'}, ${'USDT'}, ${'BTC'}, ${'USDT'}, ${RATE_BPS}, ${5000},
      ${7500}, ${8500}, ${9500}, ${6500},
      ${200}, ${2500}, ${3600}
    )
    RETURNING id::text AS id
  `;
  const loans = await tx<Array<{ id: string }>>`
    INSERT INTO bank.loans (
      product_id, user_id, debt_asset_id, collateral_asset_id, quote_asset_id,
      apr_bps, principal, status
    ) VALUES (
      ${products[0]!.id}, ${'l1103-user'}, ${'USDT'}, ${'BTC'}, ${'USDT'},
      ${RATE_BPS}, ${LOAN_PRINCIPAL}::numeric, ${'active'}
    )
    RETURNING id::text AS id
  `;
  return loans[0]!.id;
}

function insertAccrual(tx: Tx, loanId: string, day: string, principal: string, interest: string) {
  return tx<StoredAccrual[]>`
    INSERT INTO bank.loan_interest_accruals (
      loan_id, accrual_date, rate_bps, principal_basis, interest_amount
    ) VALUES (
      ${loanId}, ${day}, ${RATE_BPS}, ${principal}::numeric, ${interest}::numeric
    )
    RETURNING id::text AS id,
              accrual_date::text AS accrual_date,
              principal_basis::text AS principal_basis,
              interest_amount::text AS interest_amount,
              (principal_basis = ${principal}::numeric) AS principal_matches,
              (interest_amount = ${interest}::numeric) AS interest_matches
  `;
}

async function rejectedAccrual(tx: Tx, loanId: string, day: string, principal: string, interest: string): Promise<unknown> {
  try {
    await tx.savepoint(async (sp) => {
      await insertAccrual(sp, loanId, day, principal, interest);
    });
    return undefined;
  } catch (err) {
    return err;
  }
}

function expectStored(row: StoredAccrual, principal: string, interest: string) {
  expect(typeof row.principal_basis).toBe('string');
  expect(typeof row.interest_amount).toBe('string');
  expect(row.principal_matches, `principal_basis stores ${principal}`).toBe(true);
  expect(row.interest_matches, `interest_amount stores ${interest}`).toBe(true);
}

describe('loan interest on a zero principal basis', () => {
  it('refuses a charge on no debt and still stores a zero charge', async () => {
    const { up, down } = migrationPair();

    try {
      await sql.begin(async (tx) => {
        if (down) await tx.unsafe(down);
        const loanId = await openLoan(tx);

        const capitalised = (await insertAccrual(tx, loanId, '2026-01-01', ZERO, CHARGE))[0]!;
        expectStored(capitalised, ZERO, CHARGE);
        expect(capitalised.interest_matches, 'interest on a zero principal basis stores before the bound').toBe(true);

        expect(
          await rejectedAccrual(tx, loanId, '2026-01-02', ZERO, NEGATIVE),
          'a negative interest amount is already refused',
        ).toMatchObject({
          code: '23514',
          constraint_name: 'loan_interest_non_negative',
        });
        expect(
          await rejectedAccrual(tx, loanId, '2026-01-03', NEGATIVE, ZERO),
          'a negative principal basis is already refused',
        ).toMatchObject({
          code: '23514',
          constraint_name: 'loan_interest_non_negative',
        });

        const before = await accruals(tx, loanId);
        if (up) await tx.unsafe(up);
        expect(await accruals(tx, loanId)).toEqual(before);

        expect(
          await rejectedAccrual(tx, loanId, '2026-01-04', ZERO, CHARGE),
          'a new insert with principal_basis 0 and interest_amount greater than 0 is refused',
        ).toMatchObject({
          code: '23514',
          constraint_name: 'loan_interest_non_negative',
        });

        const zeroCharge = (await insertAccrual(tx, loanId, '2026-01-05', ZERO, ZERO))[0]!;
        expectStored(zeroCharge, ZERO, ZERO);

        const positive = (await insertAccrual(tx, loanId, '2026-01-06', BASIS, CHARGE))[0]!;
        expectStored(positive, BASIS, CHARGE);

        const positiveBasisZeroCharge = (await insertAccrual(tx, loanId, '2026-01-07', BASIS, ZERO))[0]!;
        expectStored(positiveBasisZeroCharge, BASIS, ZERO);

        expect(await rejectedAccrual(tx, loanId, '2026-01-08', ZERO, NEGATIVE), 'a negative interest amount stays refused').toMatchObject({
          code: '23514',
          constraint_name: 'loan_interest_non_negative',
        });
        expect(await rejectedAccrual(tx, loanId, '2026-01-09', NEGATIVE, CHARGE), 'a negative principal basis stays refused').toMatchObject(
          {
            code: '23514',
            constraint_name: 'loan_interest_non_negative',
          },
        );

        const after = await accruals(tx, loanId);
        for (const row of before) {
          expect(after.find((stored) => stored.id === row.id)).toEqual(row);
        }

        throw new RollBack();
      });
    } catch (err) {
      if (!(err instanceof RollBack)) throw err;
    }
  }, 30_000);
});
