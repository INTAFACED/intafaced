import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { SUPPORT_KB_AUTHORING_ERROR_CODES, type Context } from '@intafaced/contracts';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { MemoryKbAuthoringBook, SqlKbAuthoringBook, type KbAuthoringBook } from './kb-authoring.js';
import { createSupportRouter } from './router.js';
import { SupportService } from './support-service.js';

/**
 * SP-kb-01 DR4 follow-ups: the draft compare-and-set (no blind overwrite), `support.kb_id_taken`, and the contract code
 * list, through the real router, on both the memory book and the Postgres book.
 */

const authConfig = {
  secret: 'a-support-kb-guards-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const OPS = '33333333-3333-4333-8333-333333333333';
const SESSION = '66666666-6666-4666-8666-666666666666';
const ARTICLE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CAT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const UNKNOWN = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const draft = { articleId: ARTICLE, expectedDraftRevision: 0, language: 'en', title: 'T', body: 'B', sectionId: null };

async function opsCaller(book: KbAuthoringBook) {
  const support = new SupportService();
  const router = createSupportRouter(support, undefined, undefined, support, undefined, undefined, book);
  const { token } = await issueAccessToken(
    { userId: OPS, sessionId: SESSION, scopes: ['support:ops'], tier: 'none', mfa: true },
    authConfig,
  );
  const ctx: Context = { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-kb-guards' };
  return router.createCaller(ctx);
}

function guards(name: string, make: () => KbAuthoringBook) {
  describe(name, () => {
    it('a stale draft save refuses support.kb_draft_stale (CONFLICT) instead of overwriting', async () => {
      const ops = await opsCaller(make());
      const first = await ops.saveKbDraft(draft);
      expect(first.draftRevision).toBe(1);
      const second = await ops.saveKbDraft({ ...draft, expectedDraftRevision: 1, title: 'Author A' });
      expect(second.draftRevision).toBe(2);
      // Author B read revision 1 and saves late: refused, and A's text stays.
      await expect(ops.saveKbDraft({ ...draft, expectedDraftRevision: 1, title: 'Author B' })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'support.kb_draft_stale',
      });
      // A second "new" draft over an existing one is stale too.
      await expect(ops.saveKbDraft(draft)).rejects.toMatchObject({ message: 'support.kb_draft_stale' });
      expect((await ops.getKbDraft({ articleId: ARTICLE }))!.title).toBe('Author A');
      // After publish the draft is gone, so the next edit starts again from 0.
      await ops.publishKbDraft({ articleId: ARTICLE, revision: 0 });
      expect((await ops.saveKbDraft(draft)).draftRevision).toBe(1);
    });

    it('the same client id with different fields is support.kb_id_taken (CONFLICT); unknown section is BAD_REQUEST', async () => {
      const ops = await opsCaller(make());
      const cat = { id: CAT, name: 'Account', position: 0, parentId: null };
      await ops.createKbCategory(cat);
      await expect(ops.createKbCategory({ ...cat, position: 3 })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'support.kb_id_taken',
      });
      await expect(ops.saveKbDraft({ ...draft, sectionId: UNKNOWN })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'support.kb_section_unknown',
      });
    });
  });
}

describe('contract codes', () => {
  it('list every code the service and router emit', () => {
    for (const code of [
      'support.kb_body_invalid',
      'support.kb_section_unknown',
      'support.kb_title_blank',
      'support.kb.revision_stale',
      'support.kb_draft_missing',
      'support.kb_category_unknown',
      'support.kb_id_taken',
      'support.kb.not_published',
      'support.kb_draft_stale',
    ]) {
      expect(SUPPORT_KB_AUTHORING_ERROR_CODES).toContain(code);
    }
  });
});

guards('memory book through the router', () => new MemoryKbAuthoringBook());

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((n) => n.endsWith('.sql') && !n.endsWith('.down.sql'))
  .sort()
  .map((n) => readFileSync(join(drizzleDir, n), 'utf8'));

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
  describe.skip('Postgres book through the router (Postgres unavailable)', () => {
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
  guards('Postgres book through the router', () => new SqlKbAuthoringBook(db.sql));
}
