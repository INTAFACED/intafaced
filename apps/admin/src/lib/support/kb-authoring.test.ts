import { describe, expect, it } from 'vitest';
import { baseRevisionOf, labelsFrom, previewParagraphs, readKbAuthoringRequest } from './kb-authoring';

const draft = {
  action: 'draft_save',
  id: 'withdraw-time',
  title: 'How long a withdrawal takes',
  body: 'A withdrawal is sent once approved.',
  language: 'en',
  sectionId: 'withdrawals',
  tags: ['withdrawal'],
  templateId: null,
  baseRevision: 0,
};

describe('help-article authoring requests (SP-kb-01, SP-kb-02)', () => {
  it('reads a draft save exactly, and refuses an extra or missing field', () => {
    expect(readKbAuthoringRequest(draft)).toMatchObject({ action: 'draft_save', id: 'withdraw-time', baseRevision: 0 });
    expect(readKbAuthoringRequest({ ...draft, authorId: 'someone-else' })).toBeNull();
    const { templateId: _t, ...missing } = draft;
    expect(readKbAuthoringRequest(missing)).toBeNull();
    expect(readKbAuthoringRequest({ ...draft, id: 'Has Spaces' })).toBeNull();
    expect(readKbAuthoringRequest({ ...draft, baseRevision: -1 })).toBeNull();
  });

  it('reads one revision for a review move; a send back needs a reason', () => {
    expect(readKbAuthoringRequest({ action: 'approve', id: 'withdraw-time', revision: 1 })).toEqual({
      action: 'approve',
      id: 'withdraw-time',
      revision: 1,
    });
    expect(readKbAuthoringRequest({ action: 'publish', id: 'withdraw-time', revision: 0 })).toBeNull();
    expect(readKbAuthoringRequest({ action: 'send_back', id: 'withdraw-time', revision: 1 })).toBeNull();
    expect(readKbAuthoringRequest({ action: 'send_back', id: 'withdraw-time', revision: 1, reason: ' too long ' })).toMatchObject({
      reason: 'too long',
    });
    expect(readKbAuthoringRequest({ action: 'delete', id: 'withdraw-time', revision: 1 })).toBeNull();
  });

  it('saves from the newest revision, splits labels, and previews the words as typed', () => {
    expect(baseRevisionOf(null)).toBe(0);
    expect(
      baseRevisionOf({
        id: 'a',
        versions: [
          { revision: 1, draft: true, state: 'published', authorId: 'x', title: 't', audience: 'public', live: false, createdAt: null },
          { revision: 2, draft: false, state: null, authorId: 'x', title: 't', audience: 'public', live: true, createdAt: null },
        ],
        trail: [],
      }),
    ).toBe(2);
    expect(labelsFrom(' a, ,b ,c')).toEqual(['a', 'b', 'c']);
    expect(previewParagraphs('<script>alert(1)</script>\n\nSecond')).toEqual(['<script>alert(1)</script>', 'Second']);
  });
});
