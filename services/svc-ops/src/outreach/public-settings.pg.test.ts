import { createTestDatabase } from '@intafaced/db';
import { describe, expect, it } from 'vitest';
import { migrateOutreach } from '../db/migrate.js';
import { PublicSettingsStaleError, SqlPublicSettingsBook } from './public-settings.js';

// The public settings book against Postgres: one row, a business-keyed append-only log, and a revision check under a race.

const AT = '2026-10-23T09:00:00.000Z';

if (!process.env.TEST_DATABASE_URL) {
  describe.skip('outreach public settings (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else
  describe('outreach public settings on real PostgreSQL', () => {
    it('stores, replays, refuses a stale revision, keeps the log append-only, and lets one of two racing founders win', async () => {
      const database = await createTestDatabase({ service: 'ops' });
      try {
        await migrateOutreach(database.sql);
        const book = new SqlPublicSettingsBook(database.sql);
        expect(await book.get()).toEqual({ joinUrl: null, partnerTerms: null, revision: 0, updatedAt: null });

        const change = { changes: { joinUrl: 'https://join.example.org' }, expectedRevision: 0, by: 'founder-a', reason: 'live', at: AT };
        const first = await book.set(change);
        expect(first).toMatchObject({ joinUrl: 'https://join.example.org', partnerTerms: null, revision: 1, updatedAt: AT });
        expect(await book.set(change)).toEqual(first);
        await expect(book.set({ ...change, changes: { joinUrl: 'https://other.example.org' } })).rejects.toBeInstanceOf(
          PublicSettingsStaleError,
        );
        const log = await database.sql`SELECT key, revision_after, set_by, reason FROM ops.public_settings_log`;
        expect(log).toEqual([{ key: 'ops.public_settings:r0', revision_after: 1, set_by: 'founder-a', reason: 'live' }]);
        await expect(database.sql`DELETE FROM ops.public_settings_log`).rejects.toThrow(/append-only/);

        const race = await Promise.allSettled([
          book.set({ changes: { partnerTerms: 'TEST terms A' }, expectedRevision: 1, by: 'founder-a', reason: 'a', at: AT }),
          book.set({ changes: { partnerTerms: 'TEST terms B' }, expectedRevision: 1, by: 'founder-b', reason: 'b', at: AT }),
        ]);
        expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(race.filter((r) => r.status === 'rejected' && r.reason instanceof PublicSettingsStaleError)).toHaveLength(1);
        expect((await book.get()).revision).toBe(2);
      } finally {
        await database.drop();
      }
    });
  });
