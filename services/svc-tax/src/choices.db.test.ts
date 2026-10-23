/**
 * The cost-basis settings store against real Postgres, with the production migration verbatim. TEST ids only.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
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

  it('the migration reverses cleanly and applies again', async () => {
    for (const down of downs) await db.sql.unsafe(down);
    expect(await db.sql`SELECT to_regclass('tax.method_choices') AS t`).toEqual([{ t: null }]);
    for (const up of ups) await db.sql.unsafe(up);
    for (const up of ups) await db.sql.unsafe(up); // re-runnable
    await store.setMethod(ADA, null, 'FIFO');
    expect((await store.read(ADA)).accountMethod).toBe('FIFO');
  });
});
