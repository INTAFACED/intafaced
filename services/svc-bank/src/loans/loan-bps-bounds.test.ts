/**
 * loan_products.target_ltv_bps can be zero or negative: loan_products_ltv_ordered
 * only requires it below margin_call. loan_products.apr_bps is only checked as
 * >= 0, so an APR above the earn-pool cap stores.
 *
 * 0002 stays as applied. 0022 refuses a new non-positive liquidation stop and
 * an APR above 1000000. A positive stop that is still below margin call stores.
 * The ordering stays. APR 0 and APR 1000000 store. A negative APR stays refused.
 * Stored rows are not rewritten. The fixture, including the down migration,
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

const MAX_LTV_BPS = 5000;
const MARGIN_CALL_LTV_BPS = 7500;
const LIQUIDATION_LTV_BPS = 8500;
const INSOLVENCY_LTV_BPS = 9500;
const PENALTY_BPS = 200;
const MAX_TRANCHE_BPS = 2500;
const GRACE_SECONDS = 3600;
const APR_CAP_BPS = 1000000;

type Tx = postgres.TransactionSql;

interface ProductRow {
  id: string;
  apr_bps: number;
  target_ltv_bps: number;
  margin_call_ltv_bps: number;
}

class RollBack extends Error {
  constructor() {
    super('roll back loan-bps fixture');
  }
}

function sqlFiles(): string[] {
  return readdirSync(drizzleDir)
    .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
    .sort();
}

function migrationPair(): { up: string; down: string } {
  const names = readdirSync(drizzleDir);
  const up = names.find((name) => /^0022_.*\.sql$/.test(name) && !name.endsWith('.down.sql'));
  const down = names.find((name) => /^0022_.*\.down\.sql$/.test(name));
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

async function products(tx: Tx): Promise<ProductRow[]> {
  return tx<ProductRow[]>`
    SELECT id::text AS id, apr_bps, target_ltv_bps, margin_call_ltv_bps
      FROM bank.loan_products
     ORDER BY id
  `;
}

function insertProduct(tx: Tx, name: string, aprBps: number, targetLtvBps: number) {
  return tx<ProductRow[]>`
    INSERT INTO bank.loan_products (
      name, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps, max_ltv_bps,
      margin_call_ltv_bps, liquidation_ltv_bps, insolvency_ltv_bps, target_ltv_bps,
      penalty_bps, max_tranche_bps, grace_seconds
    ) VALUES (
      ${name}, ${'USDT'}, ${'BTC'}, ${'USDT'}, ${aprBps}, ${MAX_LTV_BPS},
      ${MARGIN_CALL_LTV_BPS}, ${LIQUIDATION_LTV_BPS}, ${INSOLVENCY_LTV_BPS}, ${targetLtvBps},
      ${PENALTY_BPS}, ${MAX_TRANCHE_BPS}, ${GRACE_SECONDS}
    )
    RETURNING id::text AS id, apr_bps, target_ltv_bps, margin_call_ltv_bps
  `;
}

async function rejectedInsert(tx: Tx, name: string, aprBps: number, targetLtvBps: number): Promise<unknown> {
  try {
    await tx.savepoint(async (sp) => {
      await insertProduct(sp, name, aprBps, targetLtvBps);
    });
    return undefined;
  } catch (err) {
    return err;
  }
}

describe('loan product liquidation stop and APR bounds', () => {
  it('refuses a non-positive liquidation stop and an APR above 1000000 on a new insert', async () => {
    const { up, down } = migrationPair();

    try {
      await sql.begin(async (tx) => {
        if (down) await tx.unsafe(down);

        const zeroStop = (await insertProduct(tx, 'l1102-zero-stop', 1000, 0))[0]!;
        expect(Number.isInteger(zeroStop.target_ltv_bps)).toBe(true);
        expect(zeroStop.target_ltv_bps, 'a zero liquidation stop stores before the bound').toBe(0);

        const negativeStop = (await insertProduct(tx, 'l1102-negative-stop', 1000, -1))[0]!;
        expect(Number.isInteger(negativeStop.target_ltv_bps)).toBe(true);
        expect(negativeStop.target_ltv_bps, 'a negative liquidation stop stores before the bound').toBe(-1);

        const uncapped = (await insertProduct(tx, 'l1102-uncapped-apr', APR_CAP_BPS + 1, 6500))[0]!;
        expect(Number.isInteger(uncapped.apr_bps)).toBe(true);
        expect(uncapped.apr_bps, 'an APR above 1000000 stores before the cap').toBe(APR_CAP_BPS + 1);

        expect(await rejectedInsert(tx, 'l1102-negative-apr-before', -1, 6500), 'a negative APR is already refused').toMatchObject({
          code: '23514',
          constraint_name: 'loan_products_bps_bounded',
        });

        const before = await products(tx);
        if (up) await tx.unsafe(up);
        expect(await products(tx)).toEqual(before);

        expect(
          await rejectedInsert(tx, 'l1102-zero-stop-after', 1000, 0),
          'a new insert with target_ltv_bps of 0 is refused',
        ).toMatchObject({
          code: '23514',
          constraint_name: 'loan_products_ltv_ordered',
        });
        expect(
          await rejectedInsert(tx, 'l1102-negative-stop-after', 1000, -1),
          'a new insert with target_ltv_bps below 0 is refused',
        ).toMatchObject({
          code: '23514',
          constraint_name: 'loan_products_ltv_ordered',
        });
        expect(
          await rejectedInsert(tx, 'l1102-uncapped-apr-after', APR_CAP_BPS + 1, 6500),
          'a new insert with apr_bps above 1000000 is refused',
        ).toMatchObject({
          code: '23514',
          constraint_name: 'loan_products_bps_bounded',
        });
        expect(await rejectedInsert(tx, 'l1102-negative-apr-after', -1, 6500), 'a negative APR stays refused').toMatchObject({
          code: '23514',
          constraint_name: 'loan_products_bps_bounded',
        });
        expect(
          await rejectedInsert(tx, 'l1102-stop-at-margin', 1000, MARGIN_CALL_LTV_BPS),
          'a liquidation stop that is not below margin call stays refused',
        ).toMatchObject({
          code: '23514',
          constraint_name: 'loan_products_ltv_ordered',
        });

        const positiveStop = (await insertProduct(tx, 'l1102-positive-stop', 1000, 1))[0]!;
        expect(Number.isInteger(positiveStop.target_ltv_bps)).toBe(true);
        expect(positiveStop.target_ltv_bps).toBe(1);
        expect(positiveStop.margin_call_ltv_bps).toBe(MARGIN_CALL_LTV_BPS);

        const aprZero = (await insertProduct(tx, 'l1102-apr-zero', 0, 6500))[0]!;
        expect(Number.isInteger(aprZero.apr_bps)).toBe(true);
        expect(aprZero.apr_bps).toBe(0);

        const aprCap = (await insertProduct(tx, 'l1102-apr-cap', APR_CAP_BPS, 6500))[0]!;
        expect(Number.isInteger(aprCap.apr_bps)).toBe(true);
        expect(aprCap.apr_bps).toBe(APR_CAP_BPS);

        const after = await products(tx);
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
