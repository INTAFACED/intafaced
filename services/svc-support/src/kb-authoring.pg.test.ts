import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { KbAuthoringError, SqlKbAuthoringBook } from './kb-authoring.js';

/** SP-kb-01 against Postgres: draft then publish, immutable versions, keyed replay, and 0030 up and down rolled back. */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));
const up0030 = readFileSync(join(drizzleDir, '0030_kb_authoring.sql'), 'utf8');
const down0030 = readFileSync(join(drizzleDir, '0030_kb_authoring.down.sql'), 'utf8');
const TABLES = ['kb_authored_articles', 'kb_authored_versions', 'kb_categories', 'kb_drafts', 'kb_sections'];

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
  describe.skip('support kb authoring (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'support', url, migrations });
  const AT = '2026-10-22T10:00:00.000Z';
  const ARTICLE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const CAT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const SEC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const draft = { articleId: ARTICLE, language: 'en', title: 'Reset your password', body: 'Open **Settings**.', sectionId: null };
  const listTables = async (q: postgres.Sql | postgres.TransactionSql) =>
    (
      await q<{ t: string }[]>`
        SELECT table_name AS t FROM information_schema.tables
        WHERE table_schema = 'support' AND table_name IN ${q(TABLES)} ORDER BY 1`
    ).map((r) => r.t);

  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.truncateAll();
  });

  describe('SqlKbAuthoringBook', () => {
    it('draft then publish -> listed once, two immutable version rows', async () => {
      const book = new SqlKbAuthoringBook(db.sql);
      await book.saveDraft(draft, 'ops-1', AT);
      expect(await book.listPublished(10)).toEqual([]);
      const v1 = await book.publish(ARTICLE, 0, 'ops-1', AT);
      expect(v1).toMatchObject({ articleId: ARTICLE, version: 1, title: 'Reset your password', publishedAt: AT });
      expect(await book.publish(ARTICLE, 0, 'ops-1', AT)).toEqual(v1);
      expect(await book.getDraft(ARTICLE)).toBeNull();
      await book.saveDraft({ ...draft, title: 'Reset (updated)' }, 'ops-1', AT);
      const v2 = await book.publish(ARTICLE, 1, 'ops-1', '2026-10-22T11:00:00.000Z');
      expect(v2.version).toBe(2);
      await expect(book.publish(ARTICLE, 0, 'ops-1', AT)).resolves.toEqual(v1);
      expect(await book.listPublished(10)).toEqual([v2]);
      const rows = await db.sql<{ version: number; publish_key: string }[]>`
        SELECT version, publish_key FROM support.kb_authored_versions WHERE article_id = ${ARTICLE} ORDER BY version`;
      expect(rows).toEqual([
        { version: 1, publish_key: `support.kb.publish:${ARTICLE}:r0` },
        { version: 2, publish_key: `support.kb.publish:${ARTICLE}:r1` },
      ]);
      await expect(db.sql`UPDATE support.kb_authored_versions SET title = 'x'`).rejects.toThrow(/immutable/);
      await expect(db.sql`DELETE FROM support.kb_authored_versions`).rejects.toThrow(/immutable/);
    });

    it('a stale revision refuses; no draft refuses; an unknown section refuses', async () => {
      const book = new SqlKbAuthoringBook(db.sql);
      await expect(book.publish(ARTICLE, 0, 'ops-1', AT)).rejects.toMatchObject({ code: 'support.kb_draft_missing' });
      await book.saveDraft(draft, 'ops-1', AT);
      await expect(book.publish(ARTICLE, 3, 'ops-1', AT)).rejects.toMatchObject({ code: 'support.kb.revision_stale' });
      await expect(book.saveDraft({ ...draft, sectionId: SEC }, 'ops-1', AT)).rejects.toBeInstanceOf(KbAuthoringError);
    });

    it('two publishers of the same draft from the same revision write one version', async () => {
      const book = new SqlKbAuthoringBook(db.sql);
      await book.saveDraft(draft, 'ops-1', AT);
      const [a, b] = await Promise.all([book.publish(ARTICLE, 0, 'ops-1', AT), book.publish(ARTICLE, 0, 'ops-2', AT)]);
      expect(a).toEqual(b);
      expect(await db.sql`SELECT 1 FROM support.kb_authored_versions`).toHaveLength(1);
    });

    it('categories and sections: ordered, replayable, unknown category refuses', async () => {
      const book = new SqlKbAuthoringBook(db.sql);
      expect(await book.categories()).toEqual({ categories: [], sections: [] });
      const cat = { id: CAT, name: 'Account', position: 0, parentId: null };
      await book.createCategory(cat, 'ops-1', AT);
      expect(await book.createCategory(cat, 'ops-1', AT)).toEqual(cat);
      await expect(book.createCategory({ ...cat, name: 'Other' }, 'ops-1', AT)).rejects.toMatchObject({ code: 'support.kb_id_taken' });
      await expect(book.createSection({ id: SEC, categoryId: ARTICLE, name: 'S', position: 0 }, 'ops-1', AT)).rejects.toMatchObject({
        code: 'support.kb_category_unknown',
      });
      const sec = { id: SEC, categoryId: CAT, name: 'Passwords', position: 0 };
      await book.createSection(sec, 'ops-1', AT);
      expect(await book.categories()).toEqual({ categories: [cat], sections: [sec] });
      await book.saveDraft({ ...draft, sectionId: SEC }, 'ops-1', AT);
      expect((await book.publish(ARTICLE, 0, 'ops-1', AT)).sectionId).toBe(SEC);
    });
  });

  describe('migration 0030', () => {
    it('down, up, up again and down inside a rolled-back transaction', async () => {
      expect(await listTables(db.sql)).toEqual(TABLES);
      const seen: string[][] = [];
      await db.sql
        .begin(async (tx) => {
          await tx.unsafe(down0030);
          seen.push(await listTables(tx));
          await tx.unsafe(up0030);
          seen.push(await listTables(tx));
          await tx.unsafe(up0030);
          await tx.unsafe(down0030);
          seen.push(await listTables(tx));
          throw new Error('rollback');
        })
        .catch((err: Error) => {
          if (err.message !== 'rollback') throw err;
        });
      expect(seen).toEqual([[], TABLES, []]);
      expect(await listTables(db.sql)).toEqual(TABLES);
    });
  });
}
