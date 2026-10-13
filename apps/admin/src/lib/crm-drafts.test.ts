import { describe, expect, it } from 'vitest';
import {
  DRAFT_KEY_PREFIX,
  DRAFT_MAX_AGE_MS,
  RESUME_KEY,
  applyDraft,
  clearAllDrafts,
  clearDraft,
  emptyDraftValues,
  keptDraft,
  keptEnquiryId,
  loadDraft,
  sanitiseDraft,
  saveDraft,
  type DraftBaseline,
  type DraftStorage,
} from './crm-drafts';

const ID = '3f2b8c1e-5d4a-4e7b-9a10-6c2d8e9f0a1b';
const OTHER = '9a7c2d11-0b3e-4f55-8c66-1d2e3f4a5b6c';
const USER = '11111111-2222-4333-8444-555555555555';
const baseline: DraftBaseline = {
  newOwner: USER,
  newStage: 'qualified',
  actionDescription: 'Send the deck',
  actionDue: '2026-10-16T09:00',
};

function memory(): DraftStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

describe('which edits are worth keeping', () => {
  it('keeps nothing when the form matches the record', () => {
    expect(keptDraft(emptyDraftValues(baseline), baseline)).toBeNull();
  });
  it('ignores blank text, and edits that only add spaces', () => {
    const values = { ...emptyDraftValues(baseline), note: '   ', editDescription: 'Send the deck  ' };
    expect(keptDraft(values, baseline)).toBeNull();
  });
  it('keeps only the fields that changed', () => {
    const values = {
      ...emptyDraftValues(baseline),
      note: 'Called, no answer',
      editDescription: 'Chase on Friday',
      editDue: '2026-10-18T09:00',
      messageText: 'Hello Ada',
      messageReason: 'Follow up',
    };
    expect(keptDraft(values, baseline)).toEqual({
      note: 'Called, no answer',
      editDescription: 'Chase on Friday',
      editDue: '2026-10-18T09:00',
      messageText: 'Hello Ada',
      messageReason: 'Follow up',
      messageKind: 'information_request',
    });
  });
  it('keeps the closing outcome only with a closed stage', () => {
    const open = { ...emptyDraftValues(baseline), disposition: 'declined' };
    expect(keptDraft(open, baseline)).toBeNull();
    const closed = { ...open, newStage: 'closed', reason: 'Not a fit' };
    expect(keptDraft(closed, baseline)).toEqual({ newStage: 'closed', disposition: 'declined', reason: 'Not a fit' });
  });
  it('restores kept fields over the freshly loaded record and ignores a stage that no longer fits', () => {
    const base = emptyDraftValues(baseline);
    const restored = applyDraft(base, { note: 'x', editDescription: 'y' }, () => true);
    expect(restored).toEqual({ ...base, note: 'x', editDescription: 'y' });
    expect(applyDraft(base, { newStage: 'terms', disposition: 'declined' }, () => false)).toEqual(base);
    expect(applyDraft(base, { newStage: 'terms' }, (stage) => stage === 'terms').newStage).toBe('terms');
  });
});

describe('what comes back out of storage', () => {
  it('drops unknown keys, wrong types, oversized text and impossible choices', () => {
    expect(
      sanitiseDraft({
        note: 'ok',
        csrf: 'secret',
        accessToken: 'secret',
        reason: 42,
        evidence: 'x'.repeat(257),
        newStage: 'launched',
        disposition: 'proceeded',
        newOwner: 'not-a-uuid',
        editDue: 'tomorrow',
        actionDue: '2026-10-18T09:00',
        messageKind: 'spam',
      }),
    ).toEqual({ note: 'ok', disposition: 'proceeded', actionDue: '2026-10-18T09:00' });
    expect(sanitiseDraft(null)).toEqual({});
    expect(sanitiseDraft([1, 2])).toEqual({});
  });
});

describe('the tab store', () => {
  const now = Date.parse('2026-10-15T10:00:00Z');
  it('keeps a draft per enquiry and gives it back', () => {
    const store = memory();
    saveDraft(store, { enquiryId: ID, userId: USER, revision: 4, fields: { note: 'Call back' } }, now);
    expect(loadDraft(store, ID, USER, now + 1000)).toEqual({ enquiryId: ID, revision: 4, fields: { note: 'Call back' } });
    expect(loadDraft(store, OTHER, USER, now)).toBeNull();
    expect(keptEnquiryId(store, USER)).toBe(ID);
    expect(keptEnquiryId(store, OTHER)).toBeNull();
    expect(keptEnquiryId(store, null)).toBeNull();
  });
  it('never writes a secret: only the typed fields, ids and times are stored', () => {
    const store = memory();
    saveDraft(store, { enquiryId: ID, userId: USER, revision: 1, fields: { note: 'hi', csrf: 'token', accessToken: 'jwt' } as never }, now);
    const stored = [...store.data.values()].join('|');
    expect(stored).not.toContain('token');
    expect(stored).not.toContain('jwt');
    expect(stored).not.toContain('csrf');
  });
  it('refuses a draft for something that is not an enquiry id', () => {
    const store = memory();
    saveDraft(store, { enquiryId: '../etc', userId: USER, revision: 1, fields: { note: 'x' } }, now);
    expect(store.data.size).toBe(0);
  });
  it('does not keep a draft that has no founder on it', () => {
    const store = memory();
    saveDraft(store, { enquiryId: ID, userId: '', revision: 1, fields: { note: 'x' } }, now);
    expect(store.data.size).toBe(0);
  });
  it('drops a draft that is old, belongs to another founder, or is damaged', () => {
    const store = memory();
    saveDraft(store, { enquiryId: ID, userId: USER, revision: 1, fields: { note: 'x' } }, now);
    expect(loadDraft(store, ID, USER, now + DRAFT_MAX_AGE_MS + 1)).toBeNull();
    expect(store.data.has(`${DRAFT_KEY_PREFIX}${ID}`)).toBe(false);
    saveDraft(store, { enquiryId: ID, userId: USER, revision: 1, fields: { note: 'x' } }, now);
    expect(loadDraft(store, ID, OTHER, now)).toBeNull();
    expect(store.data.has(`${DRAFT_KEY_PREFIX}${ID}`)).toBe(false);
    store.data.set(`${DRAFT_KEY_PREFIX}${ID}`, '{not json');
    expect(loadDraft(store, ID, USER, now)).toBeNull();
    expect(store.data.has(`${DRAFT_KEY_PREFIX}${ID}`)).toBe(false);
  });
  it('fails closed: a draft stored with no founder, or read with no founder, is refused and removed', () => {
    const store = memory();
    saveDraft(store, { enquiryId: ID, userId: USER, revision: 2, fields: { note: 'x' } }, now);
    expect(loadDraft(store, ID, null, now)).toBeNull();
    saveDraft(store, { enquiryId: ID, userId: USER, revision: 2, fields: { note: 'x' } }, now);
    expect(loadDraft(store, ID, undefined, now)).toBeNull();
    store.data.set(
      `${DRAFT_KEY_PREFIX}${ID}`,
      JSON.stringify({ v: 1, enquiryId: ID, userId: null, revision: 2, savedAt: now, fields: { note: 'x' } }),
    );
    expect(loadDraft(store, ID, USER, now)).toBeNull();
    expect(store.data.has(`${DRAFT_KEY_PREFIX}${ID}`)).toBe(false);
  });
  it('ignores a resume pointer from another founder, a bare id, or damage', () => {
    const store = memory();
    saveDraft(store, { enquiryId: ID, userId: USER, revision: 2, fields: { note: 'x' } }, now);
    expect(keptEnquiryId(store, OTHER)).toBeNull();
    store.data.set(RESUME_KEY, ID);
    expect(keptEnquiryId(store, USER)).toBeNull();
    store.data.set(RESUME_KEY, '{oops');
    expect(keptEnquiryId(store, USER)).toBeNull();
  });
  it('clears one draft after a save, and the pointer only if it points at that enquiry', () => {
    const store = memory();
    saveDraft(store, { enquiryId: ID, userId: USER, revision: 1, fields: { note: 'x' } }, now);
    saveDraft(store, { enquiryId: OTHER, userId: USER, revision: 1, fields: { note: 'y' } }, now);
    clearDraft(store, ID);
    expect(loadDraft(store, ID, USER, now)).toBeNull();
    expect(loadDraft(store, OTHER, USER, now)).not.toBeNull();
    expect(keptEnquiryId(store, USER)).toBe(OTHER);
    clearDraft(store, OTHER);
    expect(keptEnquiryId(store, USER)).toBeNull();
  });
  it('clears every draft and the pointer on sign-out, leaving other keys alone', () => {
    const store = memory();
    store.setItem('unrelated', 'keep');
    saveDraft(store, { enquiryId: ID, userId: USER, revision: 1, fields: { note: 'x' } }, now);
    saveDraft(store, { enquiryId: OTHER, userId: USER, revision: 1, fields: { note: 'y' } }, now);
    clearAllDrafts(store);
    expect([...store.data.keys()]).toEqual(['unrelated']);
    expect(store.getItem(RESUME_KEY)).toBeNull();
  });
  it('works without storage at all', () => {
    expect(() => saveDraft(null, { enquiryId: ID, userId: USER, revision: 1, fields: { note: 'x' } })).not.toThrow();
    expect(loadDraft(null, ID, USER)).toBeNull();
    expect(() => clearDraft(null, ID)).not.toThrow();
    expect(() => clearAllDrafts(null)).not.toThrow();
    expect(keptEnquiryId(null, USER)).toBeNull();
  });
  it('survives a storage that throws', () => {
    const broken: DraftStorage = {
      length: 0,
      key: () => {
        throw new Error('blocked');
      },
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => saveDraft(broken, { enquiryId: ID, userId: USER, revision: 1, fields: { note: 'x' } })).not.toThrow();
    expect(loadDraft(broken, ID, USER)).toBeNull();
    expect(() => clearDraft(broken, ID)).not.toThrow();
    expect(() => clearAllDrafts(broken)).not.toThrow();
    expect(keptEnquiryId(broken, USER)).toBeNull();
  });
});
