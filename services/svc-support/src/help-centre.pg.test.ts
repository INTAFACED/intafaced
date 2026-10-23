import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import {
  HelpCentreInvalidError,
  HelpCentreLanguagesUnsetError,
  HelpCentreNotFoundError,
  HelpCentreStaleError,
  SqlHelpCentreBook,
} from './help-centre.js';

/** SP-help-centre-03 against Postgres: one settings row, an append-only log, and translation receipts. */

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
const AT = '2026-10-23T12:00:00.000Z';
const blank = {
  name: null,
  address: null,
  defaultLanguage: null,
  languages: null,
  setupMode: null,
  published: null,
  revision: 0,
  updatedAt: null,
};

if (!url) {
  describe.skip('help centre settings (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'support', url, migrations });
  const change = (over: Record<string, unknown> = {}) => ({
    changes: { published: false as boolean | null },
    expectedRevision: 0,
    by: 'lead-1',
    reason: 'Switch the help centre off',
    at: AT,
    ...over,
  });

  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.truncateAll();
  });

  /** Truncate drops the seeded spine. One article and its version, in one transaction so the deferred head check passes. */
  async function seedArticle(): Promise<void> {
    await db.sql.begin(async (tx) => {
      await tx`
        INSERT INTO support.kb_articles (id, title_key, body_key, revision, published)
        VALUES ('kb-account-access', 'support.kb.account_access.title', 'support.kb.account_access.body', 1, true)
      `;
      await tx`
        INSERT INTO support.kb_article_versions (id, version, title_key, body_key)
        VALUES ('kb-account-access', 1, 'support.kb.account_access.title', 'support.kb.account_access.body')
      `;
    });
  }

  describe('SqlHelpCentreBook', () => {
    it('reads blank before the owner sets anything, and a read writes nothing', async () => {
      const book = new SqlHelpCentreBook(db.sql);
      expect(await book.get()).toEqual(blank);
      expect(await db.sql`SELECT 1 FROM support.help_centre`).toHaveLength(0);
    });

    it('turns the switch off, replays the lost reply, refuses a stale write and keeps one log row', async () => {
      const book = new SqlHelpCentreBook(db.sql);
      const first = await book.set(change());
      expect(first).toMatchObject({ published: false, revision: 1, updatedAt: AT });
      expect(await book.set(change())).toEqual(first);
      await expect(book.set(change({ changes: { published: true } }))).rejects.toBeInstanceOf(HelpCentreStaleError);
      const log = await db.sql<
        { key: string; revision_after: number; set_by: string; reason: string }[]
      >`SELECT key, revision_after, set_by, reason FROM support.help_centre_log`;
      expect(log).toEqual([{ key: 'support.helpCentre:r0', revision_after: 1, set_by: 'lead-1', reason: 'Switch the help centre off' }]);
      const on = await book.set(change({ changes: { published: true }, expectedRevision: 1, reason: 'Publish the help centre' }));
      expect(on.published).toBe(true);
      expect(await db.sql`SELECT 1 FROM support.help_centre_log`).toHaveLength(2);
    });

    it('two writers from the same revision: one wins, the other is refused and nothing is lost', async () => {
      const book = new SqlHelpCentreBook(db.sql);
      const results = await Promise.allSettled([
        book.set(change({ changes: { name: 'Help' } })),
        book.set(change({ changes: { setupMode: 'live' } })),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect((await book.get()).revision).toBe(1);
      expect(await db.sql`SELECT 1 FROM support.help_centre_log`).toHaveLength(1);
    });

    it('refuses a default language outside the offered list and leaves the row unchanged', async () => {
      const book = new SqlHelpCentreBook(db.sql);
      await expect(book.set(change({ changes: { languages: ['en'], defaultLanguage: 'fr' } }))).rejects.toBeInstanceOf(
        HelpCentreInvalidError,
      );
      expect(await book.get()).toEqual(blank);
      expect(await db.sql`SELECT 1 FROM support.help_centre`).toHaveLength(0);
    });

    it('with no languages, a language request refuses and the desk list is not zero', async () => {
      const book = new SqlHelpCentreBook(db.sql);
      await expect(book.language({ language: 'en' })).rejects.toBeInstanceOf(HelpCentreLanguagesUnsetError);
      expect(await book.listTranslations(10)).toEqual({ languages: null, total: null, rows: [] });
      await expect(book.listTranslations(undefined)).rejects.toMatchObject({ message: 'support.help_centre_list_limit_unset' });
    });

    it('lists a real article as missing, records one translation, and a replay keeps the first state', async () => {
      await seedArticle();
      const book = new SqlHelpCentreBook(db.sql);
      await book.set(change({ changes: { languages: ['en', 'fr'], defaultLanguage: 'en', published: false } }));
      const read = await book.language({ language: 'fr', articleId: 'kb-account-access', version: 1 });
      expect(read.published).toBe(false);
      expect(read.translation).toEqual({ articleId: 'kb-account-access', version: 1, state: 'missing' });
      const mark = {
        articleId: 'kb-account-access',
        version: 1,
        language: 'en',
        state: 'translated' as const,
        clientRequestId: 'translate-account-en-1',
        by: 'agent-1',
        reason: 'English body is in the catalogue',
        at: AT,
      };
      expect(await book.setTranslation(mark)).toMatchObject({ state: 'translated' });
      expect(await book.setTranslation({ ...mark, state: 'missing' })).toMatchObject({ state: 'translated' });
      expect(await db.sql`SELECT state FROM support.help_centre_translation WHERE article_id = 'kb-account-access'`).toEqual([
        { state: 'translated' },
      ]);
      expect(await db.sql`SELECT 1 FROM support.help_centre_translation_log`).toHaveLength(1);
      const page = await book.listTranslations(50);
      expect(page).toMatchObject({
        languages: ['en', 'fr'],
        total: 2,
        rows: [
          { articleId: 'kb-account-access', version: 1, language: 'en', state: 'translated' },
          { articleId: 'kb-account-access', version: 1, language: 'fr', state: 'missing' },
        ],
      });
      await expect(
        book.setTranslation({ ...mark, articleId: 'kb-not-real', clientRequestId: 'translate-missing-1' }),
      ).rejects.toBeInstanceOf(HelpCentreNotFoundError);
    });

    it('the logs refuse update and delete, and a bad language or address cannot be stored', async () => {
      await seedArticle();
      const book = new SqlHelpCentreBook(db.sql);
      await book.set(change());
      await book.set(
        change({
          changes: { languages: ['en'], defaultLanguage: 'en' },
          expectedRevision: 1,
          reason: 'Offer English',
        }),
      );
      await book.setTranslation({
        articleId: 'kb-account-access',
        version: 1,
        language: 'en',
        state: 'translated',
        clientRequestId: 'translate-account-en-1',
        by: 'agent-1',
        reason: 'English body is in the catalogue',
        at: AT,
      });
      await expect(db.sql`UPDATE support.help_centre_log SET reason = 'x'`).rejects.toThrow(/append-only/);
      await expect(db.sql`DELETE FROM support.help_centre_log`).rejects.toThrow(/append-only/);
      await expect(db.sql`UPDATE support.help_centre_translation_log SET reason = 'x'`).rejects.toThrow(/append-only/);
      await expect(db.sql`DELETE FROM support.help_centre_translation_log`).rejects.toThrow(/append-only/);
      await expect(db.sql`UPDATE support.help_centre SET address = 'http://help.example.test'`).rejects.toThrow();
      await expect(db.sql`UPDATE support.help_centre SET languages = ARRAY['EN']`).rejects.toThrow(/setting_invalid/);
      await expect(db.sql`INSERT INTO support.help_centre (singleton) VALUES (false)`).rejects.toThrow();
    });
  });
}
