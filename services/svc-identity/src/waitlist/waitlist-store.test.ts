import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresAvailable, rewriteSchemaSql } from '@intafaced/db';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { MemoryWaitlistStore, SqlWaitlistStore, WaitlistStoreError } from './waitlist-store.js';

describe('MemoryWaitlistStore', () => {
  it('refuses unknown and self referral', async () => {
    const store = new MemoryWaitlistStore();
    await expect(store.enroll({ email: 'a@example.com', referredBy: 'aaaaaaaaaaaa' })).rejects.toBeInstanceOf(WaitlistStoreError);
    const a = await store.enroll({ email: 'a@example.com' });
    await expect(store.enroll({ email: 'a@example.com', referredBy: a.entry.referralCode })).resolves.toMatchObject({
      created: false,
    });
  });
});

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('SqlWaitlistStore (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db = await createTestDb({
    service: 'identity',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const store = new SqlWaitlistStore(db.sql);

  beforeEach(async () => {
    await db.truncateAll();
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('SqlWaitlistStore', () => {
    it('persists FIFO rows and referral attribution', async () => {
      const a = await store.enroll({ email: 'Ada@example.com' });
      const b = await store.enroll({ email: 'bob@example.com', referredBy: a.entry.referralCode });
      expect(a.created).toBe(true);
      expect(b.entry.position).toBe(2);
      expect(b.entry.referredBy).toBe(a.entry.referralCode);

      const again = await store.enroll({ email: 'ada@example.com' });
      expect(again.created).toBe(false);
      expect(again.entry.id).toBe(a.entry.id);

      const late = await store.enroll({ email: 'late@example.com' });
      const attached = await store.enroll({ email: 'late@example.com', referredBy: a.entry.referralCode });
      expect(attached.created).toBe(false);
      expect(attached.entry.referredBy).toBe(a.entry.referralCode);
      expect(attached.entry.position).toBe(late.entry.position);
      expect((await store.getByCode(a.entry.referralCode))?.referredCount).toBe(2);

      const listed = await store.list({ limit: 10, offset: 0 });
      expect(listed.total).toBe(3);
      expect((await store.getByCode(a.entry.referralCode))?.referredCount).toBe(2);
    });

    it('refuses an unknown referrer without inserting', async () => {
      await expect(store.enroll({ email: 'ghost@example.com', referredBy: 'aaaaaaaaaaaa' })).rejects.toMatchObject({
        code: 'waitlist.unknown_referrer',
      });
      expect(await store.count()).toBe(0);
    });
  });
}
