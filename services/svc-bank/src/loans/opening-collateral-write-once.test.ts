/**
 * opening_collateral is the amount pledged at insert. 0008 checks NULL or
 * positive, so a later update can replace one positive amount with another,
 * or fill a legacy NULL. Rows that never locked stay NULL, and the same-terms
 * compare runs only when the column is set.
 *
 * 0008 stays as applied. 0028 refuses a change of the column. A pledged 10
 * stays 10. A NULL stays NULL when an update tries to set 10. An update of
 * another column leaves opening_collateral untouched. The positive CHECK
 * stays. Money is numeric(38,18), compared as decimal strings. The fixture
 * runs in a transaction and rolls back.
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

const PLEDGED = '10';
const REWRITE = '1';
const PRINCIPAL = '100';
const CHECK_VIOLATION = '23514';
const RATE_BPS = 1000;

type Tx = postgres.TransactionSql;

interface OpeningRow {
  id: string;
  status: string;
  opening_collateral: string | null;
  matches_pledged: boolean;
  matches_rewrite: boolean;
  is_null: boolean;
}

class RollBack extends Error {
  constructor() {
    super('roll back opening-collateral fixture');
  }
}

function sqlFiles(): string[] {
  return readdirSync(drizzleDir)
    .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
    .sort();
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

async function opening(tx: Tx, loanId: string): Promise<OpeningRow> {
  const rows = await tx<OpeningRow[]>`
    SELECT id::text AS id,
           status::text AS status,
           opening_collateral::text AS opening_collateral,
           (opening_collateral IS NOT NULL AND opening_collateral = ${PLEDGED}::numeric) AS matches_pledged,
           (opening_collateral IS NOT NULL AND opening_collateral = ${REWRITE}::numeric) AS matches_rewrite,
           (opening_collateral IS NULL) AS is_null
      FROM bank.loans
     WHERE id = ${loanId}
  `;
  return rows[0]!;
}

async function openProduct(tx: Tx): Promise<string> {
  const products = await tx<Array<{ id: string }>>`
    INSERT INTO bank.loan_products (
      name, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps, max_ltv_bps,
      margin_call_ltv_bps, liquidation_ltv_bps, insolvency_ltv_bps, target_ltv_bps,
      penalty_bps, max_tranche_bps, grace_seconds
    ) VALUES (
      ${'l1125-opening-collateral'}, ${'USDT'}, ${'BTC'}, ${'USDT'}, ${RATE_BPS}, ${5000},
      ${7500}, ${8500}, ${9500}, ${6500},
      ${200}, ${2500}, ${3600}
    )
    RETURNING id::text AS id
  `;
  return products[0]!.id;
}

async function openLoan(tx: Tx, productId: string, pledged: string | null): Promise<string> {
  const loans = await tx<Array<{ id: string }>>`
    INSERT INTO bank.loans (
      product_id, user_id, debt_asset_id, collateral_asset_id, quote_asset_id,
      apr_bps, principal, opening_collateral
    ) VALUES (
      ${productId}, ${'l1125-user'}, ${'USDT'}, ${'BTC'}, ${'USDT'},
      ${RATE_BPS}, ${PRINCIPAL}::numeric, ${pledged}::numeric
    )
    RETURNING id::text AS id
  `;
  return loans[0]!.id;
}

async function rejectedOpening(tx: Tx, loanId: string, amount: string): Promise<unknown> {
  try {
    await tx.savepoint(async (sp) => {
      await sp`
        UPDATE bank.loans
           SET opening_collateral = ${amount}::numeric
         WHERE id = ${loanId}
      `;
    });
    return undefined;
  } catch (err) {
    return err;
  }
}

describe('opening collateral is write-once at insert', () => {
  it('keeps a pledged amount, leaves a legacy null null, and allows another column to change', async () => {
    try {
      await sql.begin(async (tx) => {
        const productId = await openProduct(tx);
        const pledgedId = await openLoan(tx, productId, PLEDGED);
        const legacyId = await openLoan(tx, productId, null);

        const pledgedBefore = await opening(tx, pledgedId);
        expect(typeof pledgedBefore.opening_collateral).toBe('string');
        expect(pledgedBefore.matches_pledged).toBe(true);
        expect(pledgedBefore.matches_rewrite).toBe(false);
        expect(pledgedBefore.is_null).toBe(false);

        const legacyBefore = await opening(tx, legacyId);
        expect(legacyBefore.opening_collateral).toBeNull();
        expect(legacyBefore.is_null).toBe(true);
        expect(legacyBefore.matches_pledged).toBe(false);

        expect(await rejectedOpening(tx, pledgedId, REWRITE), 'changing 10 to 1 is refused').toMatchObject({
          code: CHECK_VIOLATION,
        });
        const pledgedAfter = await opening(tx, pledgedId);
        expect(pledgedAfter.opening_collateral).toBe(pledgedBefore.opening_collateral);
        expect(pledgedAfter.matches_pledged).toBe(true);
        expect(pledgedAfter.matches_rewrite).toBe(false);
        expect(pledgedAfter.status).toBe(pledgedBefore.status);

        expect(await rejectedOpening(tx, legacyId, PLEDGED), 'filling a legacy NULL with 10 is refused').toMatchObject({
          code: CHECK_VIOLATION,
        });
        const legacyAfter = await opening(tx, legacyId);
        expect(legacyAfter.opening_collateral).toBeNull();
        expect(legacyAfter.is_null).toBe(true);
        expect(legacyAfter.status).toBe(legacyBefore.status);

        await tx`
          UPDATE bank.loans
             SET status = 'active'
           WHERE id = ${pledgedId}
        `;
        const pledgedMoved = await opening(tx, pledgedId);
        expect(pledgedMoved.status).toBe('active');
        expect(pledgedMoved.opening_collateral).toBe(pledgedBefore.opening_collateral);
        expect(pledgedMoved.matches_pledged).toBe(true);

        await tx`
          UPDATE bank.loans
             SET status = 'active'
           WHERE id = ${legacyId}
        `;
        const legacyMoved = await opening(tx, legacyId);
        expect(legacyMoved.status).toBe('active');
        expect(legacyMoved.opening_collateral).toBeNull();
        expect(legacyMoved.is_null).toBe(true);

        let nonPositive: unknown;
        try {
          await tx.savepoint(async (sp) => {
            await openLoan(sp, productId, '0');
          });
        } catch (err) {
          nonPositive = err;
        }
        expect(nonPositive, 'a non-positive opening amount stays refused').toMatchObject({
          code: CHECK_VIOLATION,
          constraint_name: 'loans_opening_collateral_positive',
        });

        const column = await tx<
          Array<{ data_type: string; numeric_precision: number; numeric_scale: number; is_nullable: string }>
        >`
          SELECT data_type, numeric_precision, numeric_scale, is_nullable
            FROM information_schema.columns
           WHERE table_schema = 'bank'
             AND table_name = 'loans'
             AND column_name = 'opening_collateral'
        `;
        expect(column[0]).toMatchObject({
          data_type: 'numeric',
          numeric_precision: 38,
          numeric_scale: 18,
          is_nullable: 'YES',
        });

        throw new RollBack();
      });
    } catch (err) {
      if (!(err instanceof RollBack)) throw err;
    }
  }, 30_000);
});
