import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { renderSupportKbBody, type Context } from '@intafaced/contracts';
import { MemoryKbAuthoringBook } from './kb-authoring.js';
import { createSupportRouter } from './router.js';
import { SupportService } from './support-service.js';

/** SP-kb-01 DR4 minors: a language filter on the public reads, and emphasis that never straddles a link. */

const authConfig = {
  secret: 'a-support-kb-language-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const OPS = '33333333-3333-4333-8333-333333333333';
const SESSION = '66666666-6666-4666-8666-666666666666';
const EN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const DE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';

async function callers() {
  const support = new SupportService();
  const router = createSupportRouter(support, undefined, undefined, support, undefined, undefined, new MemoryKbAuthoringBook());
  const { token } = await issueAccessToken(
    { userId: OPS, sessionId: SESSION, scopes: ['support:ops'], tier: 'none', mfa: true },
    authConfig,
  );
  const opsCtx: Context = { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-kb-lang' };
  const anon: Context = { principal: null, service: null, region: 'DE', requestId: 'req-kb-lang' };
  return { ops: router.createCaller(opsCtx), visitor: router.createCaller(anon) };
}

describe('public reads filter by language', () => {
  it('listKbAuthored with a language returns only that language; omitted returns all', async () => {
    const { ops, visitor } = await callers();
    for (const [articleId, language] of [
      [EN, 'en'],
      [DE, 'de'],
    ] as const) {
      await ops.saveKbDraft({ articleId, expectedDraftRevision: 0, language, title: `T ${language}`, body: 'B', sectionId: null });
      await ops.publishKbDraft({ articleId, revision: 0 });
    }
    expect((await visitor.listKbAuthored({ limit: 10, language: 'de' })).map((a) => a.articleId)).toEqual([DE]);
    expect((await visitor.listKbAuthored({ limit: 10, language: 'en' })).map((a) => a.articleId)).toEqual([EN]);
    expect(await visitor.listKbAuthored({ limit: 10, language: 'fr' })).toEqual([]);
    expect((await visitor.listKbAuthored({ limit: 10 })).map((a) => a.articleId).sort()).toEqual([EN, DE].sort());
    expect((await visitor.getKbAuthored({ articleId: DE, language: 'de' })).language).toBe('de');
    await expect(visitor.getKbAuthored({ articleId: DE, language: 'en' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'support.kb.not_published',
    });
    await expect(visitor.listKbAuthored({ limit: 10, language: 'EN!' } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('renderer nesting', () => {
  it('emphasis never straddles a link boundary', () => {
    const html = renderSupportKbBody('*a [b*c](https://x.test)');
    expect(html).toBe('<p>*a <a href="https://x.test" rel="noopener noreferrer nofollow">b*c</a></p>');
    expect(html).not.toMatch(/<em>[^<]*<a/);
  });

  it('emphasis inside a link label and around a link still renders', () => {
    expect(renderSupportKbBody('**see** [the *guide*](https://x.test/g) *now*')).toBe(
      '<p><strong>see</strong> <a href="https://x.test/g" rel="noopener noreferrer nofollow">the <em>guide</em></a> <em>now</em></p>',
    );
  });

  it('existing output is unchanged for bodies without links', () => {
    expect(renderSupportKbBody('**b** *i*\n\n- one\n- two')).toBe('<p><strong>b</strong> <em>i</em></p><ul><li>one</li><li>two</li></ul>');
  });
});
