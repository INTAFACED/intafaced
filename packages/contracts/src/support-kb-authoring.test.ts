import { describe, expect, it } from 'vitest';
import {
  SUPPORT_KB_BODY_MAX,
  kbBodyIsRestrictedFormat,
  kbHistoryInputSchema,
  saveKbCategoryInputSchema,
  saveKbDraftInputSchema,
  saveKbSectionInputSchema,
  supportKbCategoryTreeSchema,
  supportKbHistorySchema,
  supportKbReaderArticleSchema,
  supportKbVersionSchema,
} from './support-kb-authoring.js';
import * as root from './index.js';

const S = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';
const U = '33333333-3333-4333-8333-333333333333';
const AT = '2026-10-22T00:00:00.000Z';

const draft = { id: 'reset-2fa', baseRevision: 0, language: 'en', title: 'Reset 2FA', body: '## Steps\n- open *Security*', sectionId: S };

describe('draft save input', () => {
  it('accepts a restricted-format body and refuses raw markup or script', () => {
    expect(saveKbDraftInputSchema.safeParse(draft).success).toBe(true);
    for (const body of ['<script>x</script>', 'hi <b>there</b>', '</div>', '<!-- c -->']) {
      const r = saveKbDraftInputSchema.safeParse({ ...draft, body });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0]?.message).toBe('support.kb_body_markup_refused');
    }
    expect(saveKbDraftInputSchema.safeParse({ ...draft, title: '<i>t</i>' }).success).toBe(false);
    expect(kbBodyIsRestrictedFormat('a < b and 3<4')).toBe(true);
  });
  it('refuses a blank body, an oversized body, a bad language, a missing section and extra keys', () => {
    expect(saveKbDraftInputSchema.safeParse({ ...draft, body: '   ' }).success).toBe(false);
    expect(saveKbDraftInputSchema.safeParse({ ...draft, body: 'x'.repeat(SUPPORT_KB_BODY_MAX + 1) }).success).toBe(false);
    expect(saveKbDraftInputSchema.safeParse({ ...draft, language: 'english' }).success).toBe(false);
    const { sectionId: _s, ...noSection } = draft;
    expect(saveKbDraftInputSchema.safeParse(noSection).success).toBe(false);
    expect(saveKbDraftInputSchema.safeParse({ ...draft, published: true }).success).toBe(false);
    expect(saveKbDraftInputSchema.safeParse({ ...draft, baseRevision: -1 }).success).toBe(false);
  });
});

describe('categories and sections', () => {
  it('parse a tree and an empty tree', () => {
    expect(supportKbCategoryTreeSchema.safeParse([]).success).toBe(true);
    const tree = [{ id: C, name: 'Account', order: 0, sections: [{ id: S, categoryId: C, name: 'Security', order: 0 }] }];
    expect(supportKbCategoryTreeSchema.safeParse(tree).success).toBe(true);
  });
  it('refuse blank names, negative order and a section with no category', () => {
    expect(saveKbCategoryInputSchema.safeParse({ name: ' ', order: 0 }).success).toBe(false);
    expect(saveKbCategoryInputSchema.safeParse({ name: 'A', order: -1 }).success).toBe(false);
    expect(saveKbSectionInputSchema.safeParse({ name: 'A', order: 0 }).success).toBe(false);
    expect(saveKbSectionInputSchema.safeParse({ categoryId: C, name: 'A', order: 0 }).success).toBe(true);
  });
});

describe('versions and history', () => {
  const version = {
    id: 'reset-2fa',
    version: 2,
    state: 'draft',
    language: 'en',
    title: 'Reset 2FA',
    body: 'text',
    sectionId: S,
    tags: [],
    authorId: U,
    savedAt: AT,
    publishedAt: null,
  };
  it('parse a draft and a published version; refuse an unknown state', () => {
    expect(supportKbVersionSchema.safeParse(version).success).toBe(true);
    expect(supportKbVersionSchema.safeParse({ ...version, state: 'published', publishedAt: AT }).success).toBe(true);
    expect(supportKbVersionSchema.safeParse({ ...version, state: 'scheduled' }).success).toBe(false);
  });
  it('history rows carry no body, and the history read needs a limit', () => {
    const { body: _b, ...row } = version;
    expect(supportKbHistorySchema.safeParse([row]).success).toBe(true);
    expect(supportKbHistorySchema.safeParse([version]).success).toBe(false);
    expect(kbHistoryInputSchema.safeParse({ id: 'reset-2fa' }).success).toBe(false);
    expect(kbHistoryInputSchema.safeParse({ id: 'reset-2fa', limit: 20 }).success).toBe(true);
  });
  it('reader article stays compatible with rows written before sections', () => {
    expect(supportKbReaderArticleSchema.safeParse({ id: 'a', titleKey: 't', bodyKey: 'b' }).success).toBe(true);
    expect(supportKbReaderArticleSchema.safeParse({ id: 'a', titleKey: 't', bodyKey: 'b', sectionId: S, language: 'es' }).success).toBe(
      true,
    );
  });
});

it('is exported from the package root', () => {
  expect(root.saveKbDraftInputSchema).toBe(saveKbDraftInputSchema);
  expect(root.SUPPORT_KB_AUTHORING_ERROR_CODES).toContain('support.kb_body_markup_refused');
});
