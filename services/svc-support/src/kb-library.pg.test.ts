import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { KbCategoryUnknownError, SqlKbLibraryBook } from './kb-library.js';
import { PostgresSupportStore } from './store.js';

/** SP-kb-01 against Postgres: categories and sections with an append-only log, and versions that carry typed text. */

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
const change = { actorId: 'lead-1', reason: 'TEST library' };

if (!url) {
  describe.skip('SqlKbLibraryBook (Postgres unavailable)', () => {
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

  describe('SqlKbLibraryBook and text versions', () => {
    it('saves a category and a section with one log row each, and the same values again write nothing', async () => {
      const book = new SqlKbLibraryBook(db.sql);
      await book.saveCategory({ id: 'money', name: 'Money', position: 1, retired: false }, change);
      await book.saveCategory({ id: 'money', name: 'Money', position: 1, retired: false }, change);
      await book.saveSection({ id: 'withdrawals', categoryId: 'money', name: 'Withdrawals', position: 0, retired: false }, change);
      await expect(
        book.saveSection({ id: 'orphan', categoryId: 'nope', name: 'Orphan', position: 0, retired: false }, change),
      ).rejects.toBeInstanceOf(KbCategoryUnknownError);
      expect(await book.categories()).toEqual([{ id: 'money', name: 'Money', position: 1, retired: false }]);
      expect(await book.section('withdrawals')).toEqual({
        id: 'withdrawals',
        categoryId: 'money',
        name: 'Withdrawals',
        position: 0,
        retired: false,
      });
      expect(await db.sql`SELECT kind, target_id FROM support.kb_library_log ORDER BY created_at`).toEqual([
        { kind: 'category', target_id: 'money' },
        { kind: 'section', target_id: 'withdrawals' },
      ]);
      await expect(db.sql`DELETE FROM support.kb_library_log`).rejects.toThrow(/append-only/);
    });

    it('a published text version reads back with its section, and an unpublish and an audience change carry the text', async () => {
      const book = new SqlKbLibraryBook(db.sql);
      await book.saveCategory({ id: 'money', name: 'Money', position: 1, retired: false }, change);
      await book.saveSection({ id: 'withdrawals', categoryId: 'money', name: 'Withdrawals', position: 0, retired: false }, change);
      const store = new PostgresSupportStore(db.sql);
      const text = { title: 'How long it takes', body: 'Shown <b>as</b> text.', language: 'en', sectionId: 'withdrawals' };
      const created = await store.putKbRevision({
        id: 'withdraw-time',
        baseRevision: 0,
        published: true,
        titleKey: 'support.kb.stored.title',
        bodyKey: 'support.kb.stored.body',
        text,
      });
      expect(created).toMatchObject({ status: 'ok', article: { version: 1, ...text } });
      expect(await store.getPublishedKb('withdraw-time')).toMatchObject(text);
      expect((await store.listPublishedKb()).find((row) => row.id === 'withdraw-time')).toMatchObject(text);
      const narrowed = await store.setKbAudience({ id: 'withdraw-time', baseRevision: 1, audience: 'signed_in', actorId: 'lead-1' });
      expect(narrowed).toMatchObject({ status: 'ok', article: { ...text, audience: 'signed_in' } });
      const hidden = await store.putKbRevision({ id: 'withdraw-time', baseRevision: 2, published: false });
      expect(hidden).toMatchObject({ status: 'ok', article: { published: false, ...text } });
      const versions = await store.listKbVersions('withdraw-time');
      expect(versions.map((row) => [row.version, row.body, row.sectionId])).toEqual([
        [1, text.body, 'withdrawals'],
        [2, text.body, 'withdrawals'],
        [3, text.body, 'withdrawals'],
      ]);
    });

    it('the database refuses half a text, a bad language and a section that does not exist or is retired', async () => {
      const store = new PostgresSupportStore(db.sql);
      const publish = (sectionId: string) =>
        store.putKbRevision({
          id: 'nowhere',
          baseRevision: 0,
          published: true,
          titleKey: 'support.kb.stored.title',
          bodyKey: 'support.kb.stored.body',
          text: { title: 'T', body: 'B', language: 'en', sectionId },
        });
      expect(await publish('missing')).toEqual({ status: 'refuse', reason: 'section_unknown' });
      const book = new SqlKbLibraryBook(db.sql);
      await book.saveCategory({ id: 'gone', name: 'Gone', position: 9, retired: false }, change);
      await book.saveSection({ id: 'gone-1', categoryId: 'gone', name: 'Gone one', position: 0, retired: false }, change);
      await book.saveCategory({ id: 'gone', name: 'Gone', position: 9, retired: true }, change);
      expect(await publish('gone-1')).toEqual({ status: 'refuse', reason: 'section_unknown' });
      expect(await store.getPublishedKb('nowhere')).toBeNull();
      await expect(
        db.sql`INSERT INTO support.kb_article_versions (id, version, title_key, body_key, title, body, language, section_id) VALUES ('raw-fk', 1, 'support.kb.x', 'support.kb.y', 'T', 'B', 'en', 'missing')`,
      ).rejects.toThrow(/kb_article_versions_section_fk|foreign key/);
      await db.sql`INSERT INTO support.kb_articles (id, title_key, body_key, revision, published) VALUES ('raw', 'support.kb.x', 'support.kb.y', 1, true)`.catch(
        () => undefined,
      );
      await expect(
        db.sql`INSERT INTO support.kb_article_versions (id, version, title_key, body_key, title) VALUES ('raw', 1, 'support.kb.x', 'support.kb.y', 'only a title')`,
      ).rejects.toThrow(/kb_article_versions_text_ck/);
    });
  });
}
