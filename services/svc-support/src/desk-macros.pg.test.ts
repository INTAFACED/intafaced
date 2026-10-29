import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { SqlMacroBook } from './desk-macros.js';

/**
 * Macros and signatures against Postgres (SP-desk-02): two leads creating one name at once leave one macro, a stale
 * revision writes nothing, the log keeps one row per write and refuses edits, and a signature moves one revision at a time.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const LEAD = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';
const AT = '2026-10-29T12:00:00.000Z';
const R = 'TEST reason';

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
  describe.skip('desk macros (Postgres unavailable)', () => {
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

  const write = { name: 'Card', folder: 'Cards', body: 'About {{ticket.subject}}', expectedRevision: 0, actorId: LEAD, reason: R, at: AT };

  describe('SqlMacroBook', () => {
    it('two leads creating one name on two connections leave one macro and one log row', async () => {
      const second = postgres(db.url, { max: 1, onnotice: () => undefined });
      try {
        const results = await Promise.all([
          new SqlMacroBook(db.sql).put({ ...write, body: 'One' }),
          new SqlMacroBook(second).put({ ...write, body: 'Two' }),
        ]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, code: 'support.macro_name_taken' }]);
        const [n] = await db.sql<{ macros: number; log: number }[]>`
          SELECT (SELECT count(*)::int FROM support.desk_macros) AS macros, (SELECT count(*)::int FROM support.desk_macro_log) AS log
        `;
        expect(n).toEqual({ macros: 1, log: 1 });
      } finally {
        await second.end({ timeout: 5 });
      }
    });

    it('a stale revision writes nothing; a retry answers the first write; the log refuses an edit', async () => {
      const book = new SqlMacroBook(db.sql);
      const made = await book.put(write);
      if (!made.ok) throw new Error(made.code);
      expect(await book.put(write)).toEqual(made);
      const changed = await book.put({ ...write, macroId: made.macro.id, body: 'Changed', expectedRevision: 1 });
      expect(changed).toMatchObject({ ok: true, macro: { revision: 2, body: 'Changed' } });
      expect(await book.put({ ...write, macroId: made.macro.id, body: 'Again', expectedRevision: 1 })).toEqual({
        ok: false,
        code: 'support.macro_revision_stale',
      });
      expect(await book.get(made.macro.id)).toMatchObject({ revision: 2, body: 'Changed' });
      const log = await db.sql`SELECT revision, reason FROM support.desk_macro_log ORDER BY revision`;
      expect(log.map((row) => `${row.revision}:${row.reason}`)).toEqual([`1:${R}`, `2:${R}`]);
      await expect(db.sql`UPDATE support.desk_macro_log SET reason = 'x'`).rejects.toThrow();
      await expect(db.sql`DELETE FROM support.desk_macro_log`).rejects.toThrow();
    });

    it('a signature moves one revision at a time; a stale write and a first-write race write nothing', async () => {
      const second = postgres(db.url, { max: 1, onnotice: () => undefined });
      try {
        const results = await Promise.all([
          new SqlMacroBook(db.sql).setSignature({ userId: AGENT, signature: 'One', expectedRevision: 0, at: AT }),
          new SqlMacroBook(second).setSignature({ userId: AGENT, signature: 'Two', expectedRevision: 0, at: AT }),
        ]);
        expect(results.filter((r) => r !== null)).toHaveLength(1);
        const book = new SqlMacroBook(db.sql);
        const now = await book.signature(AGENT);
        expect(now.revision).toBe(1);
        expect(await book.setSignature({ userId: AGENT, signature: 'Three', expectedRevision: 0, at: AT })).toBeNull();
        expect(await book.setSignature({ userId: AGENT, signature: 'Three', expectedRevision: 1, at: AT })).toEqual({
          signature: 'Three',
          revision: 2,
        });
        expect(await book.signature(LEAD)).toEqual({ signature: null, revision: 0 });
      } finally {
        await second.end({ timeout: 5 });
      }
    });
  });
}
