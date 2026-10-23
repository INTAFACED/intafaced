import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable } from '@intafaced/db/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { createPgBasisStore, type BasisWrite } from './basis-store.js';

/**
 * Private database per run (`createTestDatabase`), so this file never truncates a shared schema.
 * The migration runs inside that database, which no other file can see.
 */

const adminUrl = process.env.TEST_DATABASE_URL_TAX?.trim() || process.env.TEST_DATABASE_URL?.trim();
if (!adminUrl && (process.env.REQUIRE_POSTGRES === '1' || process.env.CI === 'true' || process.env.CI === '1')) {
  throw new Error('TEST_DATABASE_URL_TAX or TEST_DATABASE_URL is required');
}
const available = adminUrl ? await postgresAvailable(adminUrl) : false;

const migration = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle', '0000_basis_override.sql'), 'utf8');
const down = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle', '0000_basis_override.down.sql'), 'utf8');

const db = available && adminUrl ? await createTestDatabase({ url: adminUrl, service: 'tax', migrations: [migration] }) : null;

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
    const cols = await db!.sql<
      { column_name: string; data_type: string; numeric_precision: number | string; numeric_scale: number | string; is_nullable: string }[]
    >`
      SELECT column_name, data_type, numeric_precision, numeric_scale, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'tax' AND table_name = 'basis_overrides' AND column_name IN ('price_per_unit', 'qty')
      ORDER BY column_name
    `;
    expect(
      cols.map((col) => ({ ...col, numeric_precision: Number(col.numeric_precision), numeric_scale: Number(col.numeric_scale) })),
    ).toEqual([
      { column_name: 'price_per_unit', data_type: 'numeric', numeric_precision: 38, numeric_scale: 18, is_nullable: 'YES' },
      { column_name: 'qty', data_type: 'numeric', numeric_precision: 38, numeric_scale: 18, is_nullable: 'YES' },
    ]);
    await expect(
      db!.sql`
        INSERT INTO tax.basis_overrides (
          user_id, lot_id, version, kind, price_per_unit, acquired_at, source_note, asset_id, qty, business_key
        ) VALUES (
          '11111111-1111-4111-8111-111111111111', 'lot:bad', 1, 'override', 'not-a-decimal',
          '2026-01-02T00:00:00.000Z', 'TEST receipt', NULL, NULL, 'basisoverride:bad'
        )
      `,
    ).rejects.toThrow();
  });

  it('reverses the migration', async () => {
    await db!.sql.unsafe(down);
    const left = await db!.sql<{ name: string }[]>`
      SELECT tablename AS name FROM pg_tables WHERE schemaname = 'tax' AND tablename = 'basis_overrides'
    `;
    expect(left).toEqual([]);
    await db!.sql.unsafe(migration);
  });
});
