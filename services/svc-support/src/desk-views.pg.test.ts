import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db/testing';
import { SqlViewBook, VIEW_CAP_UNSET } from './desk-views.js';

/** SP-desk-01 — the view book on Postgres: one row, a replay, a stale revision, a blank cap, an append-only log. */

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
const OWNER = '33333333-3333-4333-8333-333333333333';
const AT = '2026-10-23T01:00:00.000Z';
const filter = { field: 'status', op: 'eq', value: 'open' };

if (!url) {
  describe.skip('desk views (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'support', url, migrations });

  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.truncateAll();
  });

  describe('SqlViewBook', () => {
    it('refuses a blank cap and writes no row', async () => {
      const book = new SqlViewBook(db.sql, { personal: null, shared: null });
      await expect(
        book.save({
          name: 'Open',
          ownerId: OWNER,
          expectedRevision: 0,
          shared: false,
          filter,
          sort: null,
          layout: null,
          favourite: false,
          reason: 'Morning queue',
          at: AT,
        }),
      ).rejects.toMatchObject({ code: VIEW_CAP_UNSET, missingKey: 'support.view_personal_cap' });
      expect(await db.sql`SELECT 1 FROM support.desk_views`).toHaveLength(0);
    });

    it('saves once, replays the same key and refuses a different payload or a stale revision', async () => {
      const book = new SqlViewBook(db.sql, { personal: 2, shared: 1 });
      const input = {
        name: 'Open',
        ownerId: OWNER,
        expectedRevision: 0,
        shared: false,
        filter,
        sort: { key: 'created' as const, dir: 'desc' as const },
        layout: 'compact',
        favourite: false,
        reason: 'Morning queue',
        at: AT,
      };
      const first = await book.save(input);
      expect(await book.save(input)).toEqual(first);
      expect(await db.sql`SELECT key FROM support.desk_view_log`).toHaveLength(1);
      await expect(book.save({ ...input, reason: 'A different reason' })).rejects.toMatchObject({ code: 'support.idempotency_conflict' });
      await expect(book.save({ ...input, expectedRevision: 9 })).rejects.toMatchObject({ code: 'support.view_revision_stale' });
      const second = await book.save({ ...input, expectedRevision: 1, reason: 'Renamed the shift' });
      expect(second.revision).toBe(2);
      expect(await book.save(input)).toEqual(first);
    });

    it('refuses update or delete of the log', async () => {
      const book = new SqlViewBook(db.sql, { personal: 1, shared: 1 });
      await book.save({
        name: 'Open',
        ownerId: OWNER,
        expectedRevision: 0,
        shared: true,
        filter,
        sort: null,
        layout: null,
        favourite: false,
        reason: 'Shared with the desk',
        at: AT,
      });
      await expect(db.sql`DELETE FROM support.desk_view_log`).rejects.toThrow(/append-only/);
    });
  });
}
