import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable } from '@intafaced/db/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { createPgChoiceStore } from './choices.js';

/**
 * The cost-basis settings store against real Postgres, with the production migration verbatim, in a private database per
 * run. TEST ids only.
 */

const adminUrl = process.env.TEST_DATABASE_URL_TAX?.trim() || process.env.TEST_DATABASE_URL?.trim();
if (!adminUrl && (process.env.REQUIRE_POSTGRES === '1' || process.env.CI === 'true' || process.env.CI === '1')) {
  throw new Error('TEST_DATABASE_URL_TAX or TEST_DATABASE_URL is required');
}
const available = adminUrl ? await postgresAvailable(adminUrl) : false;

const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const up = readFileSync(join(drizzleDir, '20261024110000_cost_basis_choices.sql'), 'utf8');
const down = readFileSync(join(drizzleDir, '20261024110000_cost_basis_choices.down.sql'), 'utf8');
const settingsUp = readFileSync(join(drizzleDir, '20261024150000_pnl_settings.sql'), 'utf8');
const settingsDown = readFileSync(join(drizzleDir, '20261024150000_pnl_settings.down.sql'), 'utf8');

const ADA = '11111111-1111-4111-8111-111111111111';
const BO = '22222222-2222-4222-8222-222222222222';

const db = available && adminUrl ? await createTestDatabase({ url: adminUrl, service: 'tax', migrations: [up, settingsUp] }) : null;

if (!db) {
  describe.skip('tax cost-basis choices (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('tax cost-basis choices', () => {
    afterAll(async () => {
      await db?.drop();
    });

    it('saves, replaces and clears each kind of choice, and reads back only the caller’s own', async () => {
      const store = createPgChoiceStore(db!.sql);
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

    it('saves, replaces and clears whether transfers count, for the caller only', async () => {
      const store = createPgChoiceStore(db!.sql);
      expect((await store.read(ADA)).includeTransfers).toBeNull();
      await store.setIncludeTransfers(ADA, false);
      await store.setIncludeTransfers(ADA, false); // the same save twice is one row
      expect((await store.read(ADA)).includeTransfers).toBe(false);
      expect((await store.read(BO)).includeTransfers).toBeNull();
      await store.setIncludeTransfers(ADA, true);
      expect((await store.read(ADA)).includeTransfers).toBe(true);
      expect(await db!.sql`SELECT count(*)::int AS n FROM tax.pnl_settings WHERE user_id = ${ADA}`).toEqual([{ n: 1 }]);
      await store.setIncludeTransfers(ADA, null);
      expect((await store.read(ADA)).includeTransfers).toBeNull();
    });

    it('refuses a method the book does not offer at the table, not only at the door', async () => {
      await expect(db!.sql`INSERT INTO tax.method_choices (user_id, asset_id, method) VALUES (${ADA}, '*', 'LOFO')`).rejects.toThrow(
        /method_choices_method_ck/,
      );
      await expect(
        db!.sql`INSERT INTO tax.method_days (user_id, day, asset_id, method) VALUES (${ADA}, '2026-10-05', '*', 'LOFO')`,
      ).rejects.toThrow(/method_days_method_ck/);
    });

    it('the migration reverses cleanly and applies again', async () => {
      await db!.sql.unsafe(settingsDown);
      await db!.sql.unsafe(down);
      expect(await db!.sql`SELECT to_regclass('tax.method_choices') AS t`).toEqual([{ t: null }]);
      expect(await db!.sql`SELECT to_regclass('tax.pnl_settings') AS t`).toEqual([{ t: null }]);
      await db!.sql.unsafe(up);
      await db!.sql.unsafe(up); // re-runnable
      await db!.sql.unsafe(settingsUp);
      await db!.sql.unsafe(settingsUp);
      const store = createPgChoiceStore(db!.sql);
      await store.setMethod(ADA, null, 'FIFO');
      await store.setIncludeTransfers(ADA, false);
      expect(await store.read(ADA)).toMatchObject({ accountMethod: 'FIFO', includeTransfers: false });
    });
  });
}
