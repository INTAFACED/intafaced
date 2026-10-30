import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { SqlKbLibraryBook } from './kb-library.js';
import { SqlKbReviewBook } from './kb-review.js';
import { KbAuthoring } from './kb-authoring.js';
import { PostgresSupportStore } from './store.js';

/** SP-kb-01 and SP-kb-02 against Postgres: drafts as immutable versions above the live head, and the second-person review. */

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
const AUTHOR = 'author-1';
const REVIEWER = 'reviewer-1';
const text = (over: Record<string, unknown> = {}) => ({
  id: 'withdraw-time',
  title: 'How long a withdrawal takes',
  body: 'A withdrawal is sent once it is approved.',
  language: 'en',
  sectionId: 'withdrawals',
  baseRevision: 0,
  ...over,
});

if (!url) {
  describe.skip('KB drafts and review (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'support', url, migrations });

  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.truncateAll();
    const library = new SqlKbLibraryBook(db.sql);
    await library.saveCategory({ id: 'money', name: 'Money', position: 1, retired: false }, change);
    await library.saveSection({ id: 'withdrawals', categoryId: 'money', name: 'Withdrawals', position: 0, retired: false }, change);
  });

  const authoring = () => {
    const store = new PostgresSupportStore(db.sql);
    return { store, kb: new KbAuthoring(store, new SqlKbReviewBook(db.sql)) };
  };

  describe('drafts and review on Postgres', () => {
    it('a draft is an immutable row above the head that readers never see, and a stale base is refused', async () => {
      const { store, kb } = authoring();
      const draft = await kb.saveDraft(AUTHOR, text());
      expect(draft).toMatchObject({ revision: 1, state: 'draft', authorId: AUTHOR });
      expect(await store.getPublishedKb('withdraw-time')).toBeNull();
      expect(await store.listKbVersions('withdraw-time')).toEqual([]);
      await expect(kb.saveDraft(AUTHOR, text({ body: 'Stale.' }))).rejects.toMatchObject({ code: 'support.kb.revision_stale' });
      await expect(db.sql`UPDATE support.kb_article_versions SET body = 'x' WHERE id = 'withdraw-time'`).rejects.toThrow(/immutable/);
      expect((await kb.history('withdraw-time')).versions.map((v) => [v.revision, v.draft, v.state])).toEqual([[1, true, 'draft']]);
    });

    it('the author cannot approve; a second operator approves once; publish goes live once with three trail rows', async () => {
      const { store, kb } = authoring();
      await kb.saveDraft(AUTHOR, text());
      await kb.submit(AUTHOR, { id: 'withdraw-time', revision: 1 });
      await expect(kb.approve(AUTHOR, { id: 'withdraw-time', revision: 1 })).rejects.toMatchObject({ code: 'support.kb_same_operator' });
      await expect(kb.publish(AUTHOR, { id: 'withdraw-time', revision: 1 })).rejects.toMatchObject({ code: 'support.kb_not_approved' });
      await kb.approve(REVIEWER, { id: 'withdraw-time', revision: 1 });
      await kb.approve(REVIEWER, { id: 'withdraw-time', revision: 1 });
      const live = await kb.publish(AUTHOR, { id: 'withdraw-time', revision: 1 });
      expect(live).toMatchObject({ version: 2, title: 'How long a withdrawal takes', sectionId: 'withdrawals' });
      expect(await kb.publish(AUTHOR, { id: 'withdraw-time', revision: 1 })).toMatchObject({ version: 2 });
      expect((await store.getPublishedKb('withdraw-time'))?.version).toBe(2);
      const history = await kb.history('withdraw-time');
      expect(history.trail.map((r) => [r.action, r.actorId])).toEqual([
        ['submit', AUTHOR],
        ['approve', REVIEWER],
        ['publish', AUTHOR],
      ]);
      expect(history.versions.map((v) => [v.revision, v.draft, v.live])).toEqual([
        [1, true, false],
        [2, false, true],
      ]);
      // The database holds the same rules: no self-approval and no rewriting the trail.
      await expect(db.sql`UPDATE support.kb_reviews SET approved_by = author_id`).rejects.toThrow(/second_operator/);
      await expect(db.sql`DELETE FROM support.kb_review_log`).rejects.toThrow(/append-only/);
    });

    it('an edit after approval is a new draft: the old approval cannot publish, and the live article stays as it was', async () => {
      const { store, kb } = authoring();
      await kb.saveDraft(AUTHOR, text());
      await kb.submit(AUTHOR, { id: 'withdraw-time', revision: 1 });
      await kb.approve(REVIEWER, { id: 'withdraw-time', revision: 1 });
      const edited = await kb.saveDraft(AUTHOR, text({ body: 'Edited.', baseRevision: 1 }));
      expect(edited).toMatchObject({ revision: 2, state: 'draft' });
      await expect(kb.publish(AUTHOR, { id: 'withdraw-time', revision: 1 })).rejects.toMatchObject({ code: 'support.kb.revision_stale' });
      expect(await store.getPublishedKb('withdraw-time')).toBeNull();
    });

    it('a draft above a live article leaves readers on the live version, and an audience change does not collide with it', async () => {
      const { store, kb } = authoring();
      await kb.saveDraft(AUTHOR, text());
      await kb.submit(AUTHOR, { id: 'withdraw-time', revision: 1 });
      await kb.approve(REVIEWER, { id: 'withdraw-time', revision: 1 });
      await kb.publish(AUTHOR, { id: 'withdraw-time', revision: 1 });
      await kb.saveDraft(AUTHOR, text({ body: 'Next words.', baseRevision: 2 }));
      expect((await store.getPublishedKb('withdraw-time'))?.body).toBe('A withdrawal is sent once it is approved.');
      const narrowed = await store.setKbAudience({ id: 'withdraw-time', baseRevision: 2, audience: 'signed_in', actorId: REVIEWER });
      expect(narrowed).toMatchObject({ status: 'ok', article: { version: 4, body: 'A withdrawal is sent once it is approved.' } });
    });

    it('a publish written before a crash settles on retry; two publishes at once make one version and no raw error', async () => {
      const { store, kb } = authoring();
      await kb.saveDraft(AUTHOR, text());
      await kb.submit(AUTHOR, { id: 'withdraw-time', revision: 1 });
      await kb.approve(REVIEWER, { id: 'withdraw-time', revision: 1 });
      const raced = await Promise.all([
        store.publishKbDraft({ id: 'withdraw-time', revision: 1 }),
        store.publishKbDraft({ id: 'withdraw-time', revision: 1 }),
      ]);
      expect(raced.map((r) => r.status).sort()).toEqual(['ok', 'refuse']);
      await kb.saveDraft(AUTHOR, text({ body: 'TEST Later edit.', baseRevision: 2 }));
      expect(await kb.publish(AUTHOR, { id: 'withdraw-time', revision: 1 })).toMatchObject({ version: 2 });
      const { trail, versions } = await kb.history('withdraw-time');
      expect(trail.map((r) => r.action)).toEqual(['submit', 'approve', 'publish']);
      expect(versions.map((v) => [v.revision, v.draft])).toEqual([
        [1, true],
        [2, false],
        [3, true],
      ]);
    });

    it('every template change is logged with who made it and why', async () => {
      const book = new SqlKbReviewBook(db.sql);
      const kb = new KbAuthoring(new PostgresSupportStore(db.sql), book);
      await kb.saveTemplate(AUTHOR, { id: 'how-to', name: 'How-to', body: 'Steps:', expectedRevision: 0, reason: 'TEST first' });
      await kb.saveTemplate(REVIEWER, {
        id: 'how-to',
        name: 'How-to',
        body: 'Steps:',
        retired: true,
        expectedRevision: 1,
        reason: 'TEST retire',
      });
      expect((await book.templateLog('how-to')).map((r) => [r.revision, r.actorId, r.reason, r.retired])).toEqual([
        [1, AUTHOR, 'TEST first', false],
        [2, REVIEWER, 'TEST retire', true],
      ]);
    });
  });
}
