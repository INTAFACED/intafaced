import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresAvailable, rewriteSchemaSql } from '@intafaced/db';
import postgres from 'postgres';
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

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const APPROVER = '22222222-2222-4222-8222-222222222222';

describe('MemoryWaitlistStore waves', () => {
  it('ranks by referrals then join order and releases once', async () => {
    const store = new MemoryWaitlistStore();
    const a = await store.enroll({ email: 'a@example.com' });
    const b = await store.enroll({ email: 'b@example.com' });
    await store.enroll({ email: 'b1@example.com', referredBy: b.entry.referralCode });
    expect((await store.standing(b.entry)).rank).toBe(1);
    expect((await store.standing(a.entry)).rank).toBe(2);
    const input = { waveNumber: 1, size: 1, flagKey: 'waitlist.enabled', releasedBy: OPERATOR, approvedBy: APPROVER };
    await store.releaseWave(input);
    expect(await store.releaseWave(input)).toMatchObject({ created: false });
    expect(await store.standing(b.entry)).toMatchObject({ rank: null, release: { waveNumber: 1 } });
    expect(await store.standing(a.entry)).toMatchObject({ rank: 1, waiting: 2 });
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

    it('ranks the waiting entries by referrals then join order, and releases a wave once', async () => {
      const a = await store.enroll({ email: 'a@example.com' });
      const b = await store.enroll({ email: 'b@example.com' });
      const c = await store.enroll({ email: 'c@example.com' });
      await store.enroll({ email: 'c1@example.com', referredBy: c.entry.referralCode });
      await store.enroll({ email: 'c2@example.com', referredBy: c.entry.referralCode });
      const rankOf = async (code: string) => store.standing((await store.getByCode(code))!);
      expect(await rankOf(c.entry.referralCode)).toEqual({ rank: 1, waiting: 5, release: null });
      expect((await rankOf(a.entry.referralCode)).rank).toBe(2);
      expect((await rankOf(b.entry.referralCode)).rank).toBe(3);

      const input = { size: 2, flagKey: 'waitlist.enabled', releasedBy: OPERATOR, approvedBy: APPROVER };
      await expect(store.releaseWave({ ...input, waveNumber: 2 })).rejects.toMatchObject({ code: 'waitlist.wave_unknown' });
      const first = await store.releaseWave({ ...input, waveNumber: 1 });
      expect(first.created).toBe(true);
      expect(first.wave).toMatchObject({ waveNumber: 1, size: 2, releasedCount: 2 });
      const again = await store.releaseWave({ ...input, waveNumber: 1 });
      expect(again).toEqual({ wave: first.wave, created: false });

      const keys = await db.sql<Array<{ entry_id: string; release_key: string }>>`
        SELECT entry_id, release_key FROM waitlist_releases ORDER BY release_key
      `;
      expect(keys.map((k) => k.entry_id).sort()).toEqual([a.entry.id, c.entry.id].sort());
      expect(keys.map((k) => k.release_key).sort()).toEqual([`wave:1:${a.entry.id}`, `wave:1:${c.entry.id}`].sort());
      expect(await rankOf(c.entry.referralCode)).toMatchObject({ rank: null, waiting: 3, release: { waveNumber: 1 } });
      expect((await rankOf(b.entry.referralCode)).rank).toBe(1);
      expect(await store.waitingCount()).toBe(3);
      expect(await store.waves()).toEqual([first.wave]);
    });

    it('two releases of the same wave at once release the top N once', async () => {
      for (const n of [1, 2, 3, 4]) await store.enroll({ email: `p${n}@example.com` });
      const input = { waveNumber: 1, size: 2, flagKey: 'waitlist.enabled', releasedBy: OPERATOR, approvedBy: APPROVER };
      const [x, y] = await Promise.all([store.releaseWave(input), store.releaseWave(input)]);
      expect([x.created, y.created].sort()).toEqual([false, true]);
      expect(x.wave.id).toBe(y.wave.id);
      const n = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM waitlist_releases`;
      expect(n[0]?.n).toBe(2);
    });

    it('releases on a pool of one connection: the release makes no other database call while it holds the lock', async () => {
      const one = postgres(URL, { max: 1, connection: { search_path: `${db.schema},public` } });
      try {
        const solo = new SqlWaitlistStore(one);
        await solo.enroll({ email: 'solo@example.com' });
        const input = { waveNumber: 1, size: 2, flagKey: 'waitlist.enabled', releasedBy: OPERATOR, approvedBy: APPROVER };
        const out = await Promise.race([
          solo.releaseWave(input),
          new Promise((_, reject) => setTimeout(() => reject(new Error('release hung on a pool of one')), 5000)),
        ]);
        expect(out).toMatchObject({ created: true, wave: { releasedCount: 1 } });
      } finally {
        await one.end();
      }
    });

    it('refuses an empty queue without writing a wave', async () => {
      const input = { waveNumber: 1, size: 2, flagKey: 'waitlist.enabled', releasedBy: OPERATOR, approvedBy: APPROVER };
      await expect(store.releaseWave(input)).rejects.toMatchObject({ code: 'waitlist.wave_empty' });
      expect(await store.waves()).toEqual([]);
    });

    it('refuses an unknown referrer without inserting', async () => {
      await expect(store.enroll({ email: 'ghost@example.com', referredBy: 'aaaaaaaaaaaa' })).rejects.toMatchObject({
        code: 'waitlist.unknown_referrer',
      });
      expect(await store.count()).toBe(0);
    });
  });
}
