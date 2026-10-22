import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { SqlHoursBook, SqlOutOfHoursReplyBook } from './support-hours.js';

/** SP-sla-02 against Postgres: the hours book, the once-per-request claim, and 0029 up and down in a rolled-back transaction. */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));
const up0029 = readFileSync(join(drizzleDir, '0029_support_business_hours.sql'), 'utf8');
const down0029 = readFileSync(join(drizzleDir, '0029_support_business_hours.down.sql'), 'utf8');

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
  describe.skip('support business hours (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'support', url, migrations });
  const AT = '2026-10-20T14:00:00.000Z';
  const value = {
    timeZone: 'Europe/Berlin',
    intervals: [{ day: 'mon' as const, open: '09:00', close: '17:00', closesNextDay: false }],
    holidays: ['2026-12-25'],
    outOfHoursReply: 'We are closed.',
  };
  const change = (over: Record<string, unknown> = {}) => ({
    value,
    expectedRevision: 0,
    by: 'lead-1',
    reason: 'Owner set the hours',
    at: AT,
    ...over,
  });
  const tables = async () =>
    (
      await db.sql<{ t: string }[]>`
        SELECT table_name AS t FROM information_schema.tables
        WHERE table_schema = 'support' AND table_name IN ('business_hours', 'business_hours_log', 'out_of_hours_replies')
        ORDER BY 1`
    ).map((r) => r.t);

  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.truncateAll();
  });

  describe('SqlHoursBook', () => {
    it('reads blank before anything is set, and a read writes nothing', async () => {
      const book = new SqlHoursBook(db.sql);
      expect(await book.get()).toEqual({
        timeZone: null,
        intervals: [],
        holidays: [],
        outOfHoursReply: null,
        revision: 0,
        updatedAt: null,
      });
      expect(await db.sql`SELECT 1 FROM support.business_hours`).toHaveLength(0);
    });

    it('sets, logs under the business key, replays a lost reply, refuses a stale revision; the log is append-only', async () => {
      const book = new SqlHoursBook(db.sql);
      const first = await book.set(change());
      expect(first).toMatchObject({ ...value, revision: 1, updatedAt: AT });
      expect(await book.get()).toEqual(first);
      expect(await book.set(change())).toEqual(first);
      await expect(book.set(change({ value: { ...value, outOfHoursReply: 'Other' } }))).rejects.toMatchObject({
        code: 'support.hours_revision_stale',
      });
      const log = await db.sql<{ key: string; revision_after: number }[]>`SELECT key, revision_after FROM support.business_hours_log`;
      expect(log).toEqual([{ key: 'support.hours:r0', revision_after: 1 }]);
      await expect(db.sql`DELETE FROM support.business_hours_log`).rejects.toThrow(/append-only/);
    });

    it('two writers from the same revision: one wins, the other is refused', async () => {
      const book = new SqlHoursBook(db.sql);
      const results = await Promise.allSettled([
        book.set(change({ value: { ...value, outOfHoursReply: 'A' } })),
        book.set(change({ value: { ...value, outOfHoursReply: 'B' } })),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await book.get()).revision).toBe(1);
    });
  });

  describe('SqlOutOfHoursReplyBook', () => {
    it('claims once per request', async () => {
      const [t] = await db.sql<{ id: string }[]>`
        INSERT INTO support.tickets (user_id, category, subject, body) VALUES (gen_random_uuid(), 'account', 's', 'b') RETURNING id`;
      const replies = new SqlOutOfHoursReplyBook(db.sql);
      expect(await replies.claim(t!.id, AT)).toBe(true);
      expect(await replies.claim(t!.id, AT)).toBe(false);
    });
  });

  describe('migration 0029', () => {
    it('down then up again inside a rolled-back transaction', async () => {
      expect(await tables()).toEqual(['business_hours', 'business_hours_log', 'out_of_hours_replies']);
      const seen: string[][] = [];
      await db.sql
        .begin(async (tx) => {
          const list = async () =>
            (
              await tx<{ t: string }[]>`
                SELECT table_name AS t FROM information_schema.tables
                WHERE table_schema = 'support' AND table_name IN ('business_hours', 'business_hours_log', 'out_of_hours_replies')
                ORDER BY 1`
            ).map((r) => r.t);
          await tx.unsafe(down0029);
          seen.push(await list());
          await tx.unsafe(up0029);
          seen.push(await list());
          await tx.unsafe(up0029); // idempotent re-run
          await tx.unsafe(down0029);
          seen.push(await list());
          throw new Error('rollback');
        })
        .catch((err: Error) => {
          if (err.message !== 'rollback') throw err;
        });
      expect(seen).toEqual([[], ['business_hours', 'business_hours_log', 'out_of_hours_replies'], []]);
      expect(await tables()).toEqual(['business_hours', 'business_hours_log', 'out_of_hours_replies']);
    });
  });
}
