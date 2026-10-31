import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { supportHelpCentreAddressProblem } from '@intafaced/contracts';
import {
  HelpCentreInvalidError,
  HelpCentreLanguagesUnsetError,
  HelpCentreConflictError,
  HelpCentreNotFoundError,
  HelpCentreLimitUnsetError,
  HelpCentreStaleError,
  SqlHelpCentreBook,
  helpCentreFingerprint,
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
  theme: null,
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
  async function seedArticle(over: { id?: string; published?: boolean; audience?: 'public' | 'signed_in' | 'staff' } = {}): Promise<void> {
    const id = over.id ?? 'kb-account-access';
    const published = over.published ?? true;
    const audience = over.audience ?? 'public';
    await db.sql.begin(async (tx) => {
      await tx`
        INSERT INTO support.kb_articles (id, title_key, body_key, revision, published)
        VALUES (${id}, 'support.kb.account_access.title', 'support.kb.account_access.body', 1, ${published})
      `;
      await tx`
        INSERT INTO support.kb_article_versions (id, version, title_key, body_key, audience)
        VALUES (${id}, 1, 'support.kb.account_access.title', 'support.kb.account_access.body', ${audience})
      `;
    });
  }

  async function languageRefusal(
    book: SqlHelpCentreBook,
    articleId: string,
    viewer: { signedIn: boolean; staff: boolean },
    version = 1,
  ): Promise<{ name: string; message: string }> {
    try {
      await book.language({ language: 'en', articleId, version, viewer });
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      return { name: err.name, message: err.message };
    }
    throw new Error(`language read of ${articleId} returned a body`);
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

    it('a lost reply retried after a later change gets the change it made, read from the log', async () => {
      const book = new SqlHelpCentreBook(db.sql);
      const off = await book.set(change());
      await book.set(change({ changes: { published: true }, expectedRevision: 1, reason: 'Switch it back on' }));
      expect(await book.set(change())).toEqual(off);
      expect((await book.get()).published).toBe(true);
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

    it('lists a real article as missing, records one translation, a replay answers it and another state on that id conflicts', async () => {
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
      expect(await book.setTranslation(mark)).toMatchObject({ state: 'translated' });
      await expect(book.setTranslation({ ...mark, state: 'missing' })).rejects.toBeInstanceOf(HelpCentreConflictError);
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
      await expect(db.sql`UPDATE support.help_centre SET address = 'http://help.example.test'`).rejects.toMatchObject({
        code: '23514',
        constraint_name: 'help_centre_address_ck',
      });
      await expect(db.sql`UPDATE support.help_centre SET languages = ARRAY['EN']`).rejects.toThrow(/setting_invalid/);
      await expect(db.sql`INSERT INTO support.help_centre (singleton) VALUES (false)`).rejects.toThrow();
    });

    it('an anonymous language read of a staff version is the same refusal as an id that was never stored', async () => {
      await seedArticle({ id: 'kb-staff-only', audience: 'staff' });
      await seedArticle({ id: 'kb-unpublished', published: false });
      await db.sql.begin(async (tx) => {
        await tx`
          INSERT INTO support.kb_articles (id, title_key, body_key, revision, published)
          VALUES ('kb-staff-head', 'support.kb.staff.title', 'support.kb.staff.body', 2, true)
        `;
        await tx`
          INSERT INTO support.kb_article_versions (id, version, title_key, body_key, audience)
          VALUES ('kb-staff-head', 1, 'support.kb.staff.old.title', 'support.kb.staff.old.body', 'public')
        `;
        await tx`
          INSERT INTO support.kb_article_versions (id, version, title_key, body_key, audience)
          VALUES ('kb-staff-head', 2, 'support.kb.staff.title', 'support.kb.staff.body', 'staff')
        `;
      });
      const book = new SqlHelpCentreBook(db.sql);
      await book.set(change({ changes: { languages: ['en'], defaultLanguage: 'en' } }));
      const anonymous = { signedIn: false, staff: false };
      const missing = await languageRefusal(book, 'kb-never-stored', anonymous);
      const hidden = await languageRefusal(book, 'kb-staff-only', anonymous);
      const customer = await languageRefusal(book, 'kb-staff-only', { signedIn: true, staff: false });
      const unpublished = await languageRefusal(book, 'kb-unpublished', anonymous);
      const olderPublic = await languageRefusal(book, 'kb-staff-head', anonymous, 1);
      expect(hidden).toEqual(missing);
      expect(customer).toEqual(missing);
      expect(unpublished).toEqual(missing);
      expect(olderPublic).toEqual(missing);
      expect(missing).toEqual({ name: 'HelpCentreNotFoundError', message: 'support.not_found' });
      expect(JSON.stringify(hidden)).not.toContain('kb-staff-only');
      expect(JSON.stringify(unpublished)).not.toContain('kb-unpublished');
      const staff = await book.language({
        language: 'en',
        articleId: 'kb-staff-only',
        version: 1,
        viewer: { signedIn: true, staff: true },
      });
      expect(staff.translation).toEqual({ articleId: 'kb-staff-only', version: 1, state: 'missing' });
      const desk = await book.listTranslations(20);
      expect(desk.rows.some((row) => row.articleId === 'kb-staff-only')).toBe(true);
    });

    it('stores a canonical https address and the check accepts exactly what the contract accepts', async () => {
      const book = new SqlHelpCentreBook(db.sql);
      const stored = await book.set(change({ changes: { address: 'HTTPS://help.example.com/home' } }));
      expect(stored.address).toBe('https://help.example.com/home');
      const again = await book.set(change({ changes: { address: 'HTTPS://help.example.com/home' } }));
      expect(again).toEqual(stored);
      expect(await db.sql`SELECT 1 FROM support.help_centre_log`).toHaveLength(1);
      const short = await book.set(change({ changes: { address: 'https://x' }, expectedRevision: 1, reason: 'Short address' }));
      expect(short.address).toBe('https://x/');
      await expect(
        book.set(change({ changes: { address: 'http://help.example.test' }, expectedRevision: 2, reason: 'Bad scheme' })),
      ).rejects.toBeInstanceOf(HelpCentreInvalidError);
      const samples = [
        'https://help.example.com/home',
        'HTTPS://help.example.com/home',
        'https://x',
        'https:x',
        'https:/x',
        'https:\\\\x',
        '  HTTPS://help.example.com/home  ',
        'https://a.b',
        'https://[::1]',
        'https://[::ffff:127.0.0.1]',
        'https://foo:8443',
        'https://foo:65535',
        'https://foo:000000',
        'https://@foo',
        'https://:@foo',
        'https://foo/bar baz',
        'https://foo/user@bar',
        'https://example.com:443/home',
        'https://.',
        'https://1',
        'HTTPS:help.example.com/home',
        'https://ex~ample.com',
        'https://foo%2eample.com',
        'https://X-%mzM',
        'https://foo:12a',
        'http://help.example.test',
        'https://user@foo',
        'https://user:pass@foo',
        'https://:pass@foo',
        'https://foo:99999',
        'https://foo:bar',
        'https://[zz]',
        'https://[:]',
        'https://',
        '',
        'not-a-url',
        `https://example.com/${'a'.repeat(190)}`,
      ];
      for (const sample of samples) {
        const [row] = await db.sql<{ ok: boolean }[]>`SELECT support.help_centre_address_ok(${sample}) AS ok`;
        expect(row?.ok, sample).toBe(supportHelpCentreAddressProblem(sample) === null);
      }
      const [nullOk] = await db.sql<{ ok: boolean }[]>`SELECT support.help_centre_address_ok(NULL) AS ok`;
      expect(nullOk?.ok).toBe(true);
      await db.sql`UPDATE support.help_centre SET address = 'https://x'`;
      await db.sql`UPDATE support.help_centre SET address = 'HTTPS://help.example.com/home'`;
      await db.sql`UPDATE support.help_centre SET address = 'https:x'`;
      const [def] = await db.sql<{ def: string }[]>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'help_centre_address_ck'
      `;
      await db.sql.unsafe('ALTER TABLE support.help_centre DROP CONSTRAINT help_centre_address_ck');
      await db.sql.unsafe(
        "ALTER TABLE support.help_centre ADD CONSTRAINT help_centre_address_ck CHECK (address IS NULL OR address = 'https:x')",
      );
      try {
        await expect(
          book.set(change({ changes: { address: 'https://help.example.com/home' }, expectedRevision: 2, reason: 'Set the address' })),
        ).rejects.toMatchObject({ name: 'HelpCentreInvalidError', message: 'support.help_centre_setting_invalid' });
        expect((await book.get()).address).toBe('https:x');
        expect((await book.get()).revision).toBe(2);
      } finally {
        await db.sql.unsafe('ALTER TABLE support.help_centre DROP CONSTRAINT help_centre_address_ck');
        await db.sql.unsafe(`ALTER TABLE support.help_centre ADD CONSTRAINT help_centre_address_ck ${def?.def ?? ''}`);
      }
    });

    it('stores the theme, the column refuses anything outside system, light and dark', async () => {
      const book = new SqlHelpCentreBook(db.sql);
      const dark = await book.set(change({ changes: { theme: 'dark' }, reason: 'Owner chose dark' }));
      expect(dark).toMatchObject({ theme: 'dark', revision: 1 });
      expect(await book.get()).toEqual(dark);
      expect(await book.set(change({ changes: { theme: 'dark' }, reason: 'Owner chose dark' }))).toEqual(dark);
      await expect(db.sql`UPDATE support.help_centre SET theme = 'neon'`).rejects.toMatchObject({
        code: '23514',
        constraint_name: 'help_centre_theme_ck',
      });
      expect((await book.set(change({ changes: { theme: null }, expectedRevision: 1, reason: 'Unset' }))).theme).toBeNull();
    });

    it('lists the change log newest first with who, why, before, after and the fields changed; a blank page size refuses', async () => {
      const book = new SqlHelpCentreBook(db.sql);
      await book.set(change());
      await book.set(change({ changes: { theme: 'light', name: 'Help' }, expectedRevision: 1, reason: 'Name and theme' }));
      const log = await book.listChanges(10);
      expect(log.map((row) => [row.revision, row.by, row.reason, row.at, row.changed])).toEqual([
        [2, 'lead-1', 'Name and theme', AT, ['name', 'theme']],
        [1, 'lead-1', 'Switch the help centre off', AT, ['published']],
      ]);
      expect(log[0]).toMatchObject({ before: { name: null, theme: null }, after: { name: 'Help', theme: 'light' } });
      expect(await book.listChanges(1)).toHaveLength(1);
      await expect(book.listChanges(undefined)).rejects.toBeInstanceOf(HelpCentreLimitUnsetError);
    });

    it('a log row written before theme existed reads with a blank theme and its lost reply still replays', async () => {
      const book = new SqlHelpCentreBook(db.sql);
      const legacy = { ...blank, published: false, revision: 1, updatedAt: AT } as Record<string, unknown>;
      delete legacy.theme;
      const before = { ...blank } as Record<string, unknown>;
      delete before.theme;
      await db.sql`INSERT INTO support.help_centre (singleton, published, revision, updated_by, updated_at) VALUES (true, false, 1, 'lead-1', ${AT})`;
      await db.sql`
        INSERT INTO support.help_centre_log (key, fingerprint, revision_after, before, after, set_by, reason, set_at)
        VALUES (
          'support.helpCentre:r0', ${helpCentreFingerprint({ published: false }, 'Switch the help centre off')}, 1,
          ${db.sql.json(before as never)}, ${db.sql.json(legacy as never)}, 'lead-1', 'Switch the help centre off', ${AT}
        )
      `;
      expect(await book.set(change())).toEqual({ ...legacy, theme: null });
      const [row] = await book.listChanges(10);
      expect(row).toMatchObject({ revision: 1, changed: ['published'], before: { theme: null }, after: { theme: null } });
    });
  });
}
