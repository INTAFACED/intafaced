/**
 * The cost-basis settings store against real Postgres, with the production migration verbatim. TEST ids only.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { postgresChoices, type ChoiceStore } from './choices.js';

const ADA = '11111111-1111-4111-8111-111111111111';
const BO = '22222222-2222-4222-8222-222222222222';

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const drizzle = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const files = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const ups = files.filter((f) => !f.endsWith('.down.sql')).map((f) => readFileSync(join(drizzle, f), 'utf8'));
const downs = files
  .filter((f) => f.endsWith('.down.sql'))
  .reverse()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

describe('cost-basis choices in Postgres', () => {
  let db: TestDatabase;
  let store: ChoiceStore;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'tax', url: adminUrl(), migrations: ups });
    store = postgresChoices(db.sql);
  }, 30_000);
  afterAll(async () => db?.drop(), 30_000);
  beforeEach(async () => db.truncateAll());

  it('saves, replaces and clears each kind of choice, and reads back only the caller’s own', async () => {
    await store.setMethod(ADA, null, 'LIFO');
    await store.setMethod(ADA, 'BTC', 'HIFO');
    await store.setMethod(ADA, 'BTC', 'AVERAGE'); // a second save replaces, never a second row
    await store.setDayMethod(ADA, '2026-10-05', null, 'FIFO');
    await store.setDayMethod(ADA, '2026-10-05', 'BTC', 'HIFO');
    await store.setPick(ADA, 'tx-sale-1', 'BTC', 'lot:tx-buy-1:BTC');
    await store.setPick(ADA, 'tx-sale-1', 'BTC', 'lot:tx-buy-2:BTC');
    await store.setMethod(BO, null, 'HIFO');

    const ada = await store.read(ADA);
    expect(ada.accountMethod).toBe('LIFO');
    expect([...ada.assetMethods]).toEqual([['BTC', 'AVERAGE']]);
    expect(ada.days).toEqual(
      expect.arrayContaining([
        { day: '2026-10-05', assetId: null, method: 'FIFO' },
        { day: '2026-10-05', assetId: 'BTC', method: 'HIFO' },
      ]),
    );
    expect(ada.days).toHaveLength(2);
    expect(ada.picks).toEqual([{ saleTxId: 'tx-sale-1', assetId: 'BTC', lotId: 'lot:tx-buy-2:BTC' }]);
    expect((await store.read(BO)).accountMethod).toBe('HIFO');
    expect((await store.read(BO)).picks).toEqual([]);

    await store.setMethod(ADA, 'BTC', null);
    await store.setDayMethod(ADA, '2026-10-05', 'BTC', null);
    await store.setPick(ADA, 'tx-sale-1', 'BTC', null);
    const cleared = await store.read(ADA);
    expect(cleared.assetMethods.size).toBe(0);
    expect(cleared.days).toEqual([{ day: '2026-10-05', assetId: null, method: 'FIFO' }]);
    expect(cleared.picks).toEqual([]);
    // Clearing one customer's choice leaves the other's.
    expect((await store.read(BO)).accountMethod).toBe('HIFO');
  });

  it('refuses a method the book does not offer at the table, not only at the door', async () => {
    await expect(db.sql`INSERT INTO tax.method_choices (user_id, asset_id, method) VALUES (${ADA}, '*', 'LOFO')`).rejects.toThrow(
      /method_choices_method_check/,
    );
  });

  it('keeps every version of an entered price, adds none for a repeat, and reads the one in force per customer', async () => {
    const lot = 'lot:tx-dep-1:BTC';
    expect(await store.setBasis(ADA, lot, amt('100'), 'receipt')).toBe(1);
    expect(await store.setBasis(ADA, lot, amt('100'), 'receipt')).toBe(1); // the same entry again: no new version
    expect(
      await Promise.all([store.setBasis(ADA, lot, amt('250.5'), 'receipt'), store.setBasis(ADA, lot, amt('250.5'), 'receipt')]),
    ).toEqual([2, 2]);
    expect((await store.read(ADA)).basis).toEqual([{ lotId: lot, pricePerUnit: amt('250.5'), note: 'receipt', version: 2 }]);
    expect((await store.read(BO)).basis).toEqual([]);
    expect(await store.setBasis(ADA, lot, null, '')).toBe(3); // removal is a version too
    expect((await store.read(ADA)).basis).toEqual([]);
    expect(await store.setBasis(ADA, lot, null, '')).toBe(3);
    expect(await store.setBasis(BO, lot, null, '')).toBe(0); // nothing to remove: nothing written
    const rows = await db.sql`SELECT version, price_per_unit::text AS price FROM tax.lot_basis WHERE user_id = ${ADA} ORDER BY version`;
    expect(rows).toEqual([
      { version: 1, price: '100.000000000000000000' },
      { version: 2, price: '250.500000000000000000' },
      { version: 3, price: null },
    ]);
  });

  it('never changes or deletes an entered price row, and refuses a zero price at the table', async () => {
    await store.setBasis(ADA, 'lot:tx-dep-1:BTC', amt('100'), '');
    await expect(db.sql`UPDATE tax.lot_basis SET price_per_unit = 1`).rejects.toThrow(/append-only/);
    await expect(db.sql`DELETE FROM tax.lot_basis`).rejects.toThrow(/append-only/);
    await expect(
      db.sql`INSERT INTO tax.lot_basis (user_id, lot_id, version, price_per_unit) VALUES (${ADA}, 'lot:x:BTC', 1, 0)`,
    ).rejects.toThrow(/lot_basis_values_check/);
  });

  it('the migration reverses cleanly and applies again', async () => {
    for (const down of downs) await db.sql.unsafe(down);
    expect(await db.sql`SELECT to_regclass('tax.method_choices') AS t`).toEqual([{ t: null }]);
    expect(await db.sql`SELECT to_regclass('tax.lot_basis') AS t`).toEqual([{ t: null }]);
    for (const up of ups) await db.sql.unsafe(up);
    for (const up of ups) await db.sql.unsafe(up); // re-runnable
    await store.setMethod(ADA, null, 'FIFO');
    expect((await store.read(ADA)).accountMethod).toBe('FIFO');
  });
});
