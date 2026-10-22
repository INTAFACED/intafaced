import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { renderSupportKbBody, saveKbDraftInputSchema, supportKbBodyProblem, supportKbPublishKey, type Context } from '@intafaced/contracts';
import { MemoryKbAuthoringBook } from './kb-authoring.js';
import { PLATFORM_KB_SPINE } from './kb-catalog.js';
import { createSupportRouter } from './router.js';
import { SupportService } from './support-service.js';

/** SP-kb-01: restricted body format, categories and sections, drafts and keyed publish (memory book and procedures). */

const authConfig = {
  secret: 'a-support-kb-authoring-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const OPS = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const SESSION = '66666666-6666-4666-8666-666666666666';
const ARTICLE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CAT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SEC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const UNKNOWN = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

async function ctx(userId: string | null, scopes: string[]): Promise<Context> {
  if (userId === null) return { principal: null, service: null, region: 'DE', requestId: 'req-kb' };
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-kb' };
}

function desk() {
  const book = new MemoryKbAuthoringBook();
  const support = new SupportService();
  const router = createSupportRouter(support, undefined, undefined, support, undefined, undefined, book);
  const as = async (userId: string | null, scopes = ['support:ops', 'support:read', 'support:write']) =>
    router.createCaller(await ctx(userId, scopes));
  return { book, support, as };
}

const draft = { articleId: ARTICLE, language: 'en', title: 'Reset your password', body: 'Open **Settings**.', sectionId: null };

describe('restricted body format', () => {
  it('script tag rendered as text', () => {
    expect(renderSupportKbBody('a &lt;script&gt; b')).toBe('<p>a &amp;lt;script&amp;gt; b</p>');
    // Even if raw markup reached the renderer, it is escaped, never a tag.
    const html = renderSupportKbBody('<script>alert(1)</script>');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
  });

  it('refuses raw HTML, blank and control characters as support.kb_body_invalid', () => {
    for (const body of ['<script>alert(1)</script>', 'hi <b>x</b>', 'a </p>', '<!-- c -->', '<?php ?>', '   ', 'a\u0007b']) {
      expect(supportKbBodyProblem(body)).not.toBeNull();
      const parsed = saveKbDraftInputSchema.safeParse({ ...draft, body });
      expect(parsed.success).toBe(false);
      expect(parsed.error!.issues.map((i) => i.message)).toContain('support.kb_body_invalid');
    }
    expect(supportKbBodyProblem('1 < 2 and 3 > 2')).toBeNull();
  });

  it('renders only the restricted set; links only https or mailto', () => {
    expect(renderSupportKbBody('**b** *i*\n\n- one\n- two')).toBe('<p><strong>b</strong> <em>i</em></p><ul><li>one</li><li>two</li></ul>');
    expect(renderSupportKbBody('[help](https://example.test/a)')).toBe(
      '<p><a href="https://example.test/a" rel="noopener noreferrer nofollow">help</a></p>',
    );
    expect(renderSupportKbBody('[x](javascript:alert(1))')).not.toContain('<a');
    expect(renderSupportKbBody('[x](https://a.test/"onmouseover=1)')).not.toMatch(/href="[^"]*"onmouseover/);
  });

  it('a blank title is support.kb_title_blank', () => {
    const parsed = saveKbDraftInputSchema.safeParse({ ...draft, title: '   ' });
    expect(parsed.error!.issues.map((i) => i.message)).toContain('support.kb_title_blank');
  });
});

describe('authoring procedures', () => {
  it('categories are empty until the owner creates them (one default section)', async () => {
    const { as } = desk();
    expect(await (await as(null)).listKbCategories()).toEqual({ categories: [], sections: [] });
  });

  it('creates categories and sections; a replay returns the same row; unknown parent or category refuses', async () => {
    const { as } = desk();
    const ops = await as(OPS);
    const cat = { id: CAT, name: 'Account', position: 0, parentId: null };
    expect(await ops.createKbCategory(cat)).toEqual(cat);
    expect(await ops.createKbCategory(cat)).toEqual(cat);
    await expect(ops.createKbCategory({ ...cat, name: 'Other' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(ops.createKbCategory({ ...cat, id: UNKNOWN, parentId: SEC })).rejects.toMatchObject({
      message: 'support.kb_category_unknown',
    });
    const sec = { id: SEC, categoryId: CAT, name: 'Passwords', position: 1 };
    expect(await ops.createKbSection(sec)).toEqual(sec);
    await expect(ops.createKbSection({ ...sec, id: UNKNOWN, categoryId: SEC })).rejects.toMatchObject({
      message: 'support.kb_category_unknown',
    });
    expect(await (await as(null)).listKbCategories()).toEqual({ categories: [cat], sections: [sec] });
  });

  it('draft then publish -> listed once; a replay returns the same version; a stale revision refuses', async () => {
    const { book, as } = desk();
    const ops = await as(OPS);
    const visitor = await as(null);
    await ops.saveKbDraft(draft);
    expect(await visitor.listKbAuthored({ limit: 10 })).toEqual([]);
    const v1 = await ops.publishKbDraft({ articleId: ARTICLE, revision: 0 });
    expect(v1).toMatchObject({ articleId: ARTICLE, version: 1, title: 'Reset your password', sectionId: null });
    expect(await ops.publishKbDraft({ articleId: ARTICLE, revision: 0 })).toEqual(v1);
    await ops.saveKbDraft({ ...draft, title: 'Reset your password (updated)' });
    const v2 = await ops.publishKbDraft({ articleId: ARTICLE, revision: 1 });
    expect(v2.version).toBe(2);
    await expect(ops.publishKbDraft({ articleId: ARTICLE, revision: 1 })).resolves.toEqual(v2);
    await ops.saveKbDraft(draft);
    await expect(ops.publishKbDraft({ articleId: ARTICLE, revision: 0 })).resolves.toEqual(v1);
    await expect(ops.publishKbDraft({ articleId: ARTICLE, revision: 5 })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'support.kb.revision_stale',
    });
    const listed = await visitor.listKbAuthored({ limit: 10 });
    expect(listed).toEqual([v2]);
    expect(await visitor.getKbAuthored({ articleId: ARTICLE })).toEqual(v2);
    expect((await book.versions(ARTICLE)).map((v) => v.version)).toEqual([1, 2]);
    expect(supportKbPublishKey(ARTICLE, 0)).toBe(`support.kb.publish:${ARTICLE}:r0`);
  });

  it('publishing with no draft is NOT_FOUND; an unknown section is support.kb_section_unknown', async () => {
    const { as } = desk();
    const ops = await as(OPS);
    await expect(ops.publishKbDraft({ articleId: ARTICLE, revision: 0 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(ops.saveKbDraft({ ...draft, sectionId: UNKNOWN })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'support.kb_section_unknown',
    });
    await expect(ops.saveKbDraft({ ...draft, body: '<script>x</script>' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('drafts never reach a visitor; writes need a support:ops session', async () => {
    const { as } = desk();
    const ops = await as(OPS);
    await ops.saveKbDraft(draft);
    const visitor = await as(null);
    await expect(visitor.getKbAuthored({ articleId: ARTICLE })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(visitor.saveKbDraft(draft)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const customer = await as(CUSTOMER, ['support:read', 'support:write']);
    await expect(customer.saveKbDraft(draft)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(customer.getKbDraft({ articleId: ARTICLE })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('spine five unchanged: the keyed spine reads the same after desk articles are published', async () => {
    const { support, as } = desk();
    const before = await support.listKb({ limit: 100 });
    expect(before.length).toBeGreaterThanOrEqual(5);
    const ops = await as(OPS);
    await ops.saveKbDraft(draft);
    await ops.publishKbDraft({ articleId: ARTICLE, revision: 0 });
    expect(await support.listKb({ limit: 100 })).toEqual(before);
    expect(PLATFORM_KB_SPINE.slice(0, 5).map((a) => a.id)).toEqual([
      'kb-account-access',
      'kb-security-basics',
      'kb-orders-status',
      'kb-deposit-withdraw-honest',
      'kb-paper-vs-live',
    ]);
  });
});
