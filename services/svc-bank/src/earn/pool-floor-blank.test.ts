/**
 * earn_pools.min_deposit DEFAULT 0 stores an allow-all floor when the insert
 * omits the limit. A blank limit is null. An explicit number, including 0,
 * stays that number.
 *
 * 0000 shipped NOT NULL DEFAULT 0. That file stays as applied. The fixture,
 * including the down migration, runs in a transaction and rolls back, so
 * stored rows stay as they were. The runner records 0020 once and skips it
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

const ASSET = 'USDT';
const FLOOR = '12.5';
const KEPT = '100';

type Tx = postgres.TransactionSql;

interface FloorRow {
  id: string;
  min_deposit: string | null;
}

interface StoredFloor extends FloorRow {
  blank: boolean;
  is_zero: boolean;
  matches_floor: boolean;
  matches_kept: boolean;
}

class RollBack extends Error {
  constructor() {
    super('roll back pool-floor fixture');
  }
}

function sqlFiles(): string[] {
  return readdirSync(drizzleDir)
    .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
    .sort();
}

function migrationPair(): { up: string; down: string } {
  const names = readdirSync(drizzleDir);
  const up = names.find((name) => /^0020_.*\.sql$/.test(name) && !name.endsWith('.down.sql'));
  const down = names.find((name) => /^0020_.*\.down\.sql$/.test(name));
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
    SELECT id::text AS id, min_deposit::text AS min_deposit
      FROM bank.earn_pools
     ORDER BY id
  `;
}

function insertOmit(tx: Tx, name: string) {
  return tx<StoredFloor[]>`
    INSERT INTO bank.earn_pools (asset_id, kind, name, apr_bps)
    VALUES (${ASSET}, 'flexible', ${name}, ${'0'})
    RETURNING id::text AS id,
              min_deposit::text AS min_deposit,
              (min_deposit IS NULL) AS blank,
              (min_deposit IS NOT NULL AND min_deposit = ${'0'}::numeric) AS is_zero,
              (min_deposit IS NOT NULL AND min_deposit = ${FLOOR}::numeric) AS matches_floor,
              (min_deposit IS NOT NULL AND min_deposit = ${KEPT}::numeric) AS matches_kept
  `;
}

function insertFloor(tx: Tx, name: string, amount: string) {
  return tx<StoredFloor[]>`
    INSERT INTO bank.earn_pools (asset_id, kind, name, apr_bps, min_deposit)
    VALUES (${ASSET}, 'flexible', ${name}, ${'0'}, ${amount}::numeric)
    RETURNING id::text AS id,
              min_deposit::text AS min_deposit,
              (min_deposit IS NULL) AS blank,
              (min_deposit IS NOT NULL AND min_deposit = ${'0'}::numeric) AS is_zero,
              (min_deposit IS NOT NULL AND min_deposit = ${FLOOR}::numeric) AS matches_floor,
              (min_deposit IS NOT NULL AND min_deposit = ${KEPT}::numeric) AS matches_kept
  `;
}

describe('earn pool min_deposit blank floor', () => {
  it('stores an omitted floor as null and keeps an explicit floor, including 0', async () => {
    const { up, down } = migrationPair();

    try {
      await sql.begin(async (tx) => {
        if (down) await tx.unsafe(down);

        const legacy = (await insertOmit(tx, 'l1100-legacy-omit'))[0]!;
        expect(legacy.blank, 'the pre-0020 default stores an allow-all floor').toBe(false);
        expect(legacy.is_zero).toBe(true);
        expect(typeof legacy.min_deposit).toBe('string');

        const kept = (await insertFloor(tx, 'l1100-kept', KEPT))[0]!;
        expect(kept.matches_kept).toBe(true);
        expect(typeof kept.min_deposit).toBe('string');

        const explicitZeroBefore = (await insertFloor(tx, 'l1100-explicit-zero-before', '0'))[0]!;
        expect(explicitZeroBefore.blank).toBe(false);
        expect(explicitZeroBefore.is_zero).toBe(true);

        const before = await floors(tx);
        if (up) await tx.unsafe(up);
        expect(await floors(tx)).toEqual(before);

        const blank = (await insertOmit(tx, 'l1100-blank'))[0]!;
        expect(blank.min_deposit, 'an omitted min_deposit is a blank limit').toBeNull();
        expect(blank.blank).toBe(true);
        expect(blank.is_zero).toBe(false);

        const explicitZero = (await insertFloor(tx, 'l1100-explicit-zero', '0'))[0]!;
        expect(explicitZero.blank).toBe(false);
        expect(explicitZero.is_zero).toBe(true);
        expect(typeof explicitZero.min_deposit).toBe('string');

        const explicitFloor = (await insertFloor(tx, 'l1100-explicit-floor', FLOOR))[0]!;
        expect(explicitFloor.blank).toBe(false);
        expect(explicitFloor.matches_floor).toBe(true);
        expect(explicitFloor.is_zero).toBe(false);
        expect(typeof explicitFloor.min_deposit).toBe('string');

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
             AND table_name = 'earn_pools'
             AND column_name = 'min_deposit'
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
              INSERT INTO bank.earn_pools (asset_id, kind, name, apr_bps, min_deposit)
              VALUES (${ASSET}, 'flexible', 'l1100-negative', ${'0'}, ${'-1'}::numeric)
            `;
          });
        } catch (err) {
          rejected = err;
        }
        expect(rejected, 'a present negative floor is still refused').toMatchObject({
          code: '23514',
          constraint_name: 'earn_pools_min_deposit_non_negative_ck',
        });

        const after = await floors(tx);
        for (const row of before) {
          expect(after.find((stored) => stored.id === row.id)).toEqual(row);
        }
        expect(after.find((stored) => stored.id === legacy.id)?.min_deposit).toBe(legacy.min_deposit);
        expect(after.find((stored) => stored.id === kept.id)?.min_deposit).toBe(kept.min_deposit);
        expect(after.find((stored) => stored.id === blank.id)?.min_deposit).toBeNull();

        const schema = readFileSync(join(here, '..', 'db', 'schema.ts'), 'utf8');
        const minDeposit = schema.split('\n').find((line) => line.includes("amount('min_deposit')"));
        expect(minDeposit, 'the Drizzle column must be declared').toBeDefined();
        expect(minDeposit).not.toMatch(/\.default\(/);
        expect(minDeposit).not.toMatch(/\.notNull\(/);

        throw new RollBack();
      });
    } catch (err) {
      if (!(err instanceof RollBack)) throw err;
    }
  }, 30_000);
});
