import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { createPgBasisStore, type BasisWrite } from './basis-store.js';

/**
 * Private database per run (`createTestDatabase`), so this file never truncates a shared schema.
 * The migration runs inside that database, which no other file can see.
 * 0000 stays text: a database that already recorded that filename does not re-run it.
 * 0001 casts price_per_unit and qty to numeric(38,18).
 */

const adminUrl = process.env.TEST_DATABASE_URL_TAX?.trim() || process.env.TEST_DATABASE_URL?.trim();
if (!adminUrl && (process.env.REQUIRE_POSTGRES === '1' || process.env.CI === 'true' || process.env.CI === '1')) {
  throw new Error('TEST_DATABASE_URL_TAX or TEST_DATABASE_URL is required');
}
const available = adminUrl ? await postgresAvailable(adminUrl) : false;

const serviceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const drizzleDir = join(serviceRoot, 'drizzle');
const readMigration = (name: string) => readFileSync(join(drizzleDir, name), 'utf8');
const recordedName = '0000_basis_override.sql';
const numericName = '0001_basis_override_numeric.sql';
const migration = readMigration(recordedName);
const numeric = readMigration(numericName);
const down = readMigration('0000_basis_override.down.sql');
const numericDown = readMigration('0001_basis_override_numeric.down.sql');

const textColumns = [
  { column_name: 'price_per_unit', data_type: 'text', numeric_precision: null, numeric_scale: null, is_nullable: 'YES' },
  { column_name: 'qty', data_type: 'text', numeric_precision: null, numeric_scale: null, is_nullable: 'YES' },
];
const numericColumns = [
  { column_name: 'price_per_unit', data_type: 'numeric', numeric_precision: 38, numeric_scale: 18, is_nullable: 'YES' },
  { column_name: 'qty', data_type: 'numeric', numeric_precision: 38, numeric_scale: 18, is_nullable: 'YES' },
];
const keptFigures = [
  { kind: 'manual', price_ok: true, qty_ok: true },
  { kind: 'override', price_ok: true, qty_ok: true },
  { kind: 'tombstone', price_ok: true, qty_ok: true },
];

type Sql = TestDatabase['sql'];

async function moneyColumns(sql: Sql) {
  const cols = await sql<
    {
      column_name: string;
      data_type: string;
      numeric_precision: number | string | null;
      numeric_scale: number | string | null;
      is_nullable: string;
    }[]
  >`
    SELECT column_name, data_type, numeric_precision, numeric_scale, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'tax' AND table_name = 'basis_overrides' AND column_name IN ('price_per_unit', 'qty')
    ORDER BY column_name
  `;
  return cols.map((col) => ({
    column_name: col.column_name,
    data_type: col.data_type,
    numeric_precision: col.numeric_precision === null ? null : Number(col.numeric_precision),
    numeric_scale: col.numeric_scale === null ? null : Number(col.numeric_scale),
    is_nullable: col.is_nullable,
  }));
}

function insertNotADecimal(sql: Sql, column: 'price_per_unit' | 'qty') {
  const price = column === 'price_per_unit' ? 'not-a-decimal' : '10';
  const qty = column === 'qty' ? 'not-a-decimal' : null;
  const kind = column === 'qty' ? 'manual' : 'override';
  const asset = column === 'qty' ? 'BTC' : null;
  return sql`
    INSERT INTO tax.basis_overrides (
      user_id, lot_id, version, kind, price_per_unit, acquired_at, source_note, asset_id, qty, business_key
    ) VALUES (
      '11111111-1111-4111-8111-111111111111', ${`lot:bad:${column}`}, 1, ${kind}, ${price},
      '2026-01-02T00:00:00.000Z', 'TEST receipt', ${asset}, ${qty}, ${`basisoverride:bad:${column}`}
    )
  `;
}

async function insertRecorded(sql: Sql) {
  await sql`
    INSERT INTO tax.basis_overrides (
      user_id, lot_id, version, kind, price_per_unit, acquired_at, source_note, asset_id, qty, business_key
    ) VALUES
      (
        '11111111-1111-4111-8111-111111111111', 'lot:old', 1, 'override', '100.50',
        '2026-01-02T00:00:00.000Z', 'TEST receipt', NULL, NULL, 'basisoverride:old'
      ),
      (
        '11111111-1111-4111-8111-111111111111', 'manual:old', 1, 'manual', '10',
        '2026-01-02T00:00:00.000Z', 'TEST receipt', 'BTC', '2.25', 'basisoverride:manual'
      ),
      (
        '11111111-1111-4111-8111-111111111111', 'lot:gone', 1, 'tombstone', NULL,
        NULL, NULL, NULL, NULL, 'basisoverride:gone'
      )
  `;
}

function figures(sql: Sql) {
  return sql<{ kind: string; price_ok: boolean; qty_ok: boolean }[]>`
    SELECT kind,
      price_per_unit::numeric(38,18) IS NOT DISTINCT FROM (
        CASE kind
          WHEN 'override' THEN 100.50::numeric(38,18)
          WHEN 'manual' THEN 10::numeric(38,18)
          ELSE NULL
        END
      ) AS price_ok,
      qty::numeric(38,18) IS NOT DISTINCT FROM (
        CASE kind WHEN 'manual' THEN 2.25::numeric(38,18) ELSE NULL END
      ) AS qty_ok
    FROM tax.basis_overrides
    ORDER BY kind
  `;
}

function migrate(url: string, reverse = false) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    // One Node process. `pnpm exec tsx` starts pnpm, then the tsx CLI, then another node.
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts', ...(reverse ? ['--down'] : [])], {
      cwd: serviceRoot,
      env: { ...process.env, DATABASE_URL: url },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (value: Buffer) => {
      output += value.toString();
    });
    child.stderr?.on('data', (value: Buffer) => {
      output += value.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

async function withDatabase(migrations: readonly string[], body: (database: TestDatabase) => Promise<void>) {
  if (!adminUrl) throw new Error('TEST_DATABASE_URL_TAX or TEST_DATABASE_URL is required');
  const database = await createTestDatabase({ url: adminUrl, service: 'tax', migrations });
  try {
    await body(database);
  } finally {
    await database.drop();
  }
}

const db = available && adminUrl ? await createTestDatabase({ url: adminUrl, service: 'tax', migrations: [migration, numeric] }) : null;

const write = (lotId: string, price: string): BasisWrite => ({
  userId: '11111111-1111-4111-8111-111111111111',
  lotId,
  kind: 'override',
  pricePerUnit: price,
  acquiredAt: '2026-01-02T00:00:00.000Z',
  sourceNote: 'TEST receipt',
  assetId: null,
  qty: null,
});

// skipIf runs the block when Postgres is up and skips only when it is absent.
describe.skipIf(!db)('tax.basis_overrides', () => {
  afterAll(async () => {
    await db?.drop();
  });

  it('stores one version for the same payload, two for two prices, and isolates the other account', async () => {
    const store = createPgBasisStore(db!.sql);
    const [first, second] = await Promise.all([store.save(write('lot:d1:BTC', '100')), store.save(write('lot:d1:BTC', '100'))]);
    expect(first.version).toBe(1);
    expect(second.version).toBe(1);
    expect(first.businessKey).toBe(second.businessKey);
    expect(first.businessKey).toBe(`basisoverride:${write('lot:d1:BTC', '100').userId}:lot:d1:BTC:1`);

    const [low, high] = await Promise.all([store.save(write('lot:d2:BTC', '100')), store.save(write('lot:d2:BTC', '200'))]);
    expect(new Set([low.version, high.version])).toEqual(new Set([1, 2]));

    const other = '33333333-3333-4333-8333-333333333333';
    expect(await store.listActive(other)).toEqual([]);
    await expect(store.clear(other, 'lot:d1:BTC')).rejects.toMatchObject({ code: 'tax.basis_override_absent' });
    const tomb = await store.clear(write('lot:d1:BTC', '100').userId, 'lot:d1:BTC');
    expect(tomb.kind).toBe('tombstone');
    expect((await store.listActive(write('lot:d1:BTC', '100').userId)).map((row) => row.lotId)).toEqual(['lot:d2:BTC']);
    const again = await store.clear(write('lot:d1:BTC', '100').userId, 'lot:d1:BTC');
    expect(again.version).toBe(tomb.version);
  });

  it('stores money as numeric and rejects a non-decimal string', async () => {
    expect(await moneyColumns(db!.sql)).toEqual(numericColumns);
    await expect(insertNotADecimal(db!.sql, 'price_per_unit')).rejects.toThrow();
    await expect(insertNotADecimal(db!.sql, 'qty')).rejects.toThrow();
  });

  it('reverses the numeric columns and then the table', async () => {
    await db!.sql.unsafe(numericDown);
    expect(await moneyColumns(db!.sql)).toEqual(textColumns);
    await db!.sql.unsafe(down);
    const left = await db!.sql<{ name: string }[]>`
      SELECT tablename AS name FROM pg_tables WHERE schemaname = 'tax' AND tablename = 'basis_overrides'
    `;
    expect(left).toEqual([]);
    await db!.sql.unsafe(migration);
    await db!.sql.unsafe(numeric);
    expect(await moneyColumns(db!.sql)).toEqual(numericColumns);
  });
});

describe.skipIf(!available)('recorded 0000 and a fresh database both end on numeric', { timeout: 90_000 }, () => {
  it('applies 0000 and 0001 through the runner on a fresh database', async () => {
    await withDatabase([], async (database) => {
      const up = await migrate(database.url);
      expect(up.code, up.output).toBe(0);
      expect(up.output).toContain(`↑ ${recordedName}`);
      expect(up.output).toContain(`↑ ${numericName}`);
      expect(await moneyColumns(database.sql)).toEqual(numericColumns);
      await expect(insertNotADecimal(database.sql, 'price_per_unit')).rejects.toThrow();
      await expect(insertNotADecimal(database.sql, 'qty')).rejects.toThrow();
      const names = await database.sql<{ name: string }[]>`SELECT name FROM tax.__migrations ORDER BY name`;
      expect(names.map((row) => row.name)).toEqual([
        recordedName,
        numericName,
        '20261024110000_cost_basis_choices.sql',
        '20261024150000_pnl_settings.sql',
      ]);
    });
  });

  it('skips a recorded text 0000, casts stored decimals, and reverses', async () => {
    await withDatabase([migration], async (database) => {
      expect(await moneyColumns(database.sql)).toEqual(textColumns);
      await insertRecorded(database.sql);
      await database.sql`
        CREATE TABLE IF NOT EXISTS tax.__migrations (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `;
      await database.sql`INSERT INTO tax.__migrations (name) VALUES (${recordedName})`;

      const up = await migrate(database.url);
      expect(up.code, up.output).toBe(0);
      expect(up.output).toContain(`· ${recordedName} (already applied)`);
      expect(up.output).not.toContain(`↑ ${recordedName}`);
      expect(up.output).toContain(`↑ ${numericName}`);
      expect(await moneyColumns(database.sql)).toEqual(numericColumns);
      expect(await figures(database.sql)).toEqual(keptFigures);
      await expect(insertNotADecimal(database.sql, 'price_per_unit')).rejects.toThrow();
      await expect(insertNotADecimal(database.sql, 'qty')).rejects.toThrow();

      await database.sql.unsafe(numericDown);
      expect(await moneyColumns(database.sql)).toEqual(textColumns);
      expect(await figures(database.sql)).toEqual(keptFigures);
      await database.sql.unsafe(numeric);
      expect(await moneyColumns(database.sql)).toEqual(numericColumns);

      const reversed = await migrate(database.url, true);
      expect(reversed.code, reversed.output).toBe(0);
      const left = await database.sql<{ name: string }[]>`
        SELECT tablename AS name FROM pg_tables WHERE schemaname = 'tax' AND tablename = 'basis_overrides'
      `;
      expect(left).toEqual([]);
      expect(await database.sql`SELECT name FROM tax.__migrations`).toEqual([]);
    });
  });

  it('refuses a stored non-decimal string and leaves the text columns', async () => {
    await withDatabase([migration], async (database) => {
      await insertNotADecimal(database.sql, 'price_per_unit');
      await database.sql`
        CREATE TABLE IF NOT EXISTS tax.__migrations (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `;
      await database.sql`INSERT INTO tax.__migrations (name) VALUES (${recordedName})`;

      const up = await migrate(database.url);
      expect(up.code, up.output).toBe(1);
      expect(up.output).toContain('invalid input syntax for type numeric');
      expect(await moneyColumns(database.sql)).toEqual(textColumns);
      const [row] = await database.sql<{ price_per_unit: string }[]>`
        SELECT price_per_unit FROM tax.basis_overrides WHERE lot_id = 'lot:bad:price_per_unit'
      `;
      expect(row?.price_per_unit).toBe('not-a-decimal');
      const names = await database.sql<{ name: string }[]>`SELECT name FROM tax.__migrations ORDER BY name`;
      expect(names.map((entry) => entry.name)).toEqual([recordedName]);
    });
  });
});
