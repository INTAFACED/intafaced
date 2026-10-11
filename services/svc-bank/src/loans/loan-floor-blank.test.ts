/**
 * loan_products.min_principal DEFAULT 0 stores an allow-all floor when the
 * insert omits the limit. A blank limit is null. An explicit number, including
 * 0, stays that number.
 *
 * 0002 shipped NOT NULL DEFAULT 0. That file stays as applied. The fixture,
 * including the down migration, runs in a transaction and rolls back, so
 * stored rows stay as they were. The runner records 0021 once and skips it
 * after that.
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

const FLOOR = '12.5';
const KEPT = '100';

type Tx = postgres.TransactionSql;

interface FloorRow {
  id: string;
  min_principal: string | null;
}

interface StoredFloor extends FloorRow {
  blank: boolean;
  is_zero: boolean;
  matches_floor: boolean;
  matches_kept: boolean;
}

class RollBack extends Error {
  constructor() {
    super('roll back loan-floor fixture');
  }
}

function sqlFiles(): string[] {
  return readdirSync(drizzleDir)
    .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
    .sort();
}

function migrationPair(): { up: string; down: string } {
  const names = readdirSync(drizzleDir);
  const up = names.find((name) => /^0021_.*\.sql$/.test(name) && !name.endsWith('.down.sql'));
  const down = names.find((name) => /^0021_.*\.down\.sql$/.test(name));
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

async function floors(tx: Tx): Promise<FloorRow[]> {
  return tx<FloorRow[]>`
    SELECT id::text AS id, min_principal::text AS min_principal
      FROM bank.loan_products
     ORDER BY id
  `;
}

function insertOmit(tx: Tx, name: string) {
  return tx<StoredFloor[]>`
    INSERT INTO bank.loan_products (
      name, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps, max_ltv_bps,
      margin_call_ltv_bps, liquidation_ltv_bps, insolvency_ltv_bps, target_ltv_bps,
      penalty_bps, max_tranche_bps, grace_seconds
    ) VALUES (
      ${name}, ${'USDT'}, ${'BTC'}, ${'USDT'}, ${1000}, ${5000},
      ${7500}, ${8500}, ${9500}, ${6500},
      ${200}, ${2500}, ${3600}
    )
    RETURNING id::text AS id,
              min_principal::text AS min_principal,
              (min_principal IS NULL) AS blank,
              (min_principal IS NOT NULL AND min_principal = ${'0'}::numeric) AS is_zero,
              (min_principal IS NOT NULL AND min_principal = ${FLOOR}::numeric) AS matches_floor,
              (min_principal IS NOT NULL AND min_principal = ${KEPT}::numeric) AS matches_kept
  `;
}

function insertFloor(tx: Tx, name: string, amount: string) {
  return tx<StoredFloor[]>`
    INSERT INTO bank.loan_products (
      name, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps, max_ltv_bps,
      margin_call_ltv_bps, liquidation_ltv_bps, insolvency_ltv_bps, target_ltv_bps,
      penalty_bps, max_tranche_bps, grace_seconds, min_principal
    ) VALUES (
      ${name}, ${'USDT'}, ${'BTC'}, ${'USDT'}, ${1000}, ${5000},
      ${7500}, ${8500}, ${9500}, ${6500},
      ${200}, ${2500}, ${3600}, ${amount}::numeric
    )
    RETURNING id::text AS id,
              min_principal::text AS min_principal,
              (min_principal IS NULL) AS blank,
              (min_principal IS NOT NULL AND min_principal = ${'0'}::numeric) AS is_zero,
              (min_principal IS NOT NULL AND min_principal = ${FLOOR}::numeric) AS matches_floor,
              (min_principal IS NOT NULL AND min_principal = ${KEPT}::numeric) AS matches_kept
  `;
}

describe('loan product min_principal blank floor', () => {
  it('stores an omitted floor as null and keeps an explicit floor, including 0', async () => {
    const { up, down } = migrationPair();

    try {
      await sql.begin(async (tx) => {
        if (down) await tx.unsafe(down);

        const legacy = (await insertOmit(tx, 'l1101-legacy-omit'))[0]!;
        expect(legacy.blank, 'the pre-0021 default stores an allow-all floor').toBe(false);
        expect(legacy.is_zero).toBe(true);
        expect(typeof legacy.min_principal).toBe('string');

        const kept = (await insertFloor(tx, 'l1101-kept', KEPT))[0]!;
        expect(kept.matches_kept).toBe(true);
        expect(typeof kept.min_principal).toBe('string');

        const explicitZeroBefore = (await insertFloor(tx, 'l1101-explicit-zero-before', '0'))[0]!;
        expect(explicitZeroBefore.blank).toBe(false);
        expect(explicitZeroBefore.is_zero).toBe(true);

        const before = await floors(tx);
        if (up) await tx.unsafe(up);
        expect(await floors(tx)).toEqual(before);

        const blank = (await insertOmit(tx, 'l1101-blank'))[0]!;
        expect(blank.min_principal, 'an omitted min_principal is a blank limit').toBeNull();
        expect(blank.blank).toBe(true);
        expect(blank.is_zero).toBe(false);

        const explicitZero = (await insertFloor(tx, 'l1101-explicit-zero', '0'))[0]!;
        expect(explicitZero.blank).toBe(false);
        expect(explicitZero.is_zero).toBe(true);
        expect(typeof explicitZero.min_principal).toBe('string');

        const explicitFloor = (await insertFloor(tx, 'l1101-explicit-floor', FLOOR))[0]!;
        expect(explicitFloor.blank).toBe(false);
        expect(explicitFloor.matches_floor).toBe(true);
        expect(explicitFloor.is_zero).toBe(false);
        expect(typeof explicitFloor.min_principal).toBe('string');

        const column = await tx<
          Array<{
            data_type: string;
            numeric_precision: number;
            numeric_scale: number;
            is_nullable: string;
            column_default: string | null;
          }>
        >`
          SELECT data_type, numeric_precision, numeric_scale, is_nullable, column_default
            FROM information_schema.columns
           WHERE table_schema = 'bank'
             AND table_name = 'loan_products'
             AND column_name = 'min_principal'
        `;
        expect(column[0]).toMatchObject({
          data_type: 'numeric',
          numeric_precision: 38,
          numeric_scale: 18,
          is_nullable: 'YES',
          column_default: null,
        });

        let rejected: unknown;
        try {
          await tx.savepoint(async (sp) => {
            await sp`
              INSERT INTO bank.loan_products (
                name, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps, max_ltv_bps,
                margin_call_ltv_bps, liquidation_ltv_bps, insolvency_ltv_bps, target_ltv_bps,
                penalty_bps, max_tranche_bps, grace_seconds, min_principal
              ) VALUES (
                ${'l1101-negative'}, ${'USDT'}, ${'BTC'}, ${'USDT'}, ${1000}, ${5000},
                ${7500}, ${8500}, ${9500}, ${6500},
                ${200}, ${2500}, ${3600}, ${'-1'}::numeric
              )
            `;
          });
        } catch (err) {
          rejected = err;
        }
        expect(rejected, 'a present negative floor is still refused').toMatchObject({
          code: '23514',
          constraint_name: 'loan_products_min_principal_non_negative_ck',
        });

        const after = await floors(tx);
        for (const row of before) {
          expect(after.find((stored) => stored.id === row.id)).toEqual(row);
        }
        expect(after.find((stored) => stored.id === legacy.id)?.min_principal).toBe(legacy.min_principal);
        expect(after.find((stored) => stored.id === kept.id)?.min_principal).toBe(kept.min_principal);
        expect(after.find((stored) => stored.id === blank.id)?.min_principal).toBeNull();

        const schema = readFileSync(join(here, '..', 'db', 'schema.ts'), 'utf8');
        const minPrincipal = schema.split('\n').find((line) => line.includes("amount('min_principal')"));
        expect(minPrincipal, 'the Drizzle column must be declared').toBeDefined();
        expect(minPrincipal).not.toMatch(/\.default\(/);
        expect(minPrincipal).not.toMatch(/\.notNull\(/);

        throw new RollBack();
      });
    } catch (err) {
      if (!(err instanceof RollBack)) throw err;
    }
  }, 30_000);
});
