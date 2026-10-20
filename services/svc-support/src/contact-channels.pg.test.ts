import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { ContactStaleError, SqlContactBook } from './contact-channels.js';

/** The contact channel book against Postgres: one row, a business-keyed append-only log, and a revision check under a race. */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

async function harnessUrl(): Promise<string | null> {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw || !(await postgresAvailable(raw))) return null;
  const name = new URL(raw).pathname.replace(/^\//, '').split('/')[0] ?? '';
  if (name.endsWith('_test')) return raw;
  const admin = postgres(raw, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe('CREATE DATABASE adminops_harness_test');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/already exists/i.test(message)) throw err;
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = new URL(raw);
  url.pathname = '/adminops_harness_test';
  return url.toString();
}

const url = await harnessUrl();

if (!url) {
  describe.skip('support contact channels (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'support', url, migrations });
  const AT = '2026-10-20T14:00:00.000Z';
  const change = (over: Record<string, unknown> = {}) => ({
    changes: { email: 'help@example.test' },
    expectedRevision: 0,
    by: 'lead-1',
    reason: 'Owner published the support email',
    at: AT,
    ...over,
  });

  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.truncateAll();
  });

  describe('SqlContactBook', () => {
    it('reads blank before the owner sets anything, and a read writes nothing', async () => {
      const book = new SqlContactBook(db.sql);
      expect(await book.get()).toEqual({ email: null, phone: null, chatHours: null, revision: 0, updatedAt: null });
      expect(await db.sql`SELECT 1 FROM support.contact_channels`).toHaveLength(0);
    });

    it('sets, logs under the business key, replays a lost reply and refuses a stale revision', async () => {
      const book = new SqlContactBook(db.sql);
      const first = await book.set(change());
      expect(first).toMatchObject({ email: 'help@example.test', revision: 1, updatedAt: AT });
      expect(await book.set(change())).toEqual(first);
      await expect(book.set(change({ changes: { email: 'other@example.test' } }))).rejects.toBeInstanceOf(ContactStaleError);
      const log = await db.sql<
        Array<{ key: string; revision_after: number; set_by: string }>
      >`SELECT key, revision_after, set_by FROM support.contact_channel_log`;
      expect(log).toEqual([{ key: 'support.contact:r0', revision_after: 1, set_by: 'lead-1' }]);
      const second = await book.set(change({ changes: { phone: '+1 555 010 0199' }, expectedRevision: 1 }));
      expect(second).toMatchObject({ email: 'help@example.test', phone: '+1 555 010 0199', revision: 2 });
      expect(await book.set(change({ changes: { phone: '+1 555 010 0199' }, expectedRevision: 2 }))).toEqual(second);
      expect(await db.sql`SELECT 1 FROM support.contact_channel_log`).toHaveLength(2);
    });

    it('two writers from the same revision: one wins, the other is refused and nothing is lost', async () => {
      const book = new SqlContactBook(db.sql);
      const results = await Promise.allSettled([
        book.set(change({ changes: { email: 'a@example.test' } })),
        book.set(change({ changes: { phone: '+1 555 010 0199' } })),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect((await book.get()).revision).toBe(1);
      expect(await db.sql`SELECT 1 FROM support.contact_channel_log`).toHaveLength(1);
    });

    it('the log refuses update and delete, and the table refuses a value the contract would refuse', async () => {
      const book = new SqlContactBook(db.sql);
      await book.set(change());
      await expect(db.sql`UPDATE support.contact_channel_log SET reason = 'x'`).rejects.toThrow(/append-only/);
      await expect(db.sql`DELETE FROM support.contact_channel_log`).rejects.toThrow(/append-only/);
      await expect(db.sql`UPDATE support.contact_channels SET email = 'x'`).rejects.toThrow();
      await expect(db.sql`INSERT INTO support.contact_channels (singleton) VALUES (false)`).rejects.toThrow();
    });
  });
}
