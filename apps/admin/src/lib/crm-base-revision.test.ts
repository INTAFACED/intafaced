import { describe, expect, it } from 'vitest';
import { baseIsStale, expectedRevisionFor, nextBaseRevision } from './crm-base-revision';
import { keptDraft, loadDraft, saveDraft, type DraftStorage } from './crm-drafts';

const ENQUIRY = '11111111-1111-4111-8111-111111111111';
const FOUNDER = '22222222-2222-4222-8222-222222222222';
const baseline = { newOwner: FOUNDER, newStage: 'new', actionDescription: 'Call', actionDue: '2026-10-20T10:00' };

function memoryStorage(): DraftStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
}

describe('base revision', () => {
  it('a restore of an older draft keeps the draft revision, so the save carries it', () => {
    const base = nextBaseRevision({ kind: 'open', loaded: 7, kept: 5 });
    expect(base).toBe(5);
    expect(baseIsStale({ id: ENQUIRY, revision: base }, ENQUIRY, 7)).toBe(true);
    expect(expectedRevisionFor({ id: ENQUIRY, revision: base }, ENQUIRY, 7)).toBe(5);
  });

  it('a restore at the current revision is not stale', () => {
    expect(nextBaseRevision({ kind: 'open', loaded: 7, kept: 7 })).toBe(7);
    expect(baseIsStale({ id: ENQUIRY, revision: 7 }, ENQUIRY, 7)).toBe(false);
  });

  it('a fresh open without a restore uses the loaded revision', () => {
    expect(nextBaseRevision({ kind: 'open', loaded: 7, kept: null })).toBe(7);
  });

  it('the stored draft still holds the old revision after the draft effect runs again', () => {
    const storage = memoryStorage();
    const now = Date.now();
    const fields = keptDraft(
      {
        note: '',
        reason: '',
        evidence: '',
        newOwner: baseline.newOwner,
        newStage: 'qualified',
        actionDescription: baseline.actionDescription,
        actionDue: baseline.actionDue,
        editDescription: baseline.actionDescription,
        editDue: baseline.actionDue,
        disposition: 'proceeded',
        messageKind: 'information_request',
        messageText: '',
        messageReason: '',
      },
      baseline,
    )!;
    saveDraft(storage, { enquiryId: ENQUIRY, userId: FOUNDER, revision: 5, fields }, now);
    // Restore at screen revision 7: the base stays 5, and the effect re-saves with the base, not the screen revision.
    const kept = loadDraft(storage, ENQUIRY, FOUNDER, now)!;
    const base = nextBaseRevision({ kind: 'open', loaded: 7, kept: kept.revision });
    saveDraft(storage, { enquiryId: ENQUIRY, userId: FOUNDER, revision: base, fields: kept.fields }, now);
    expect(loadDraft(storage, ENQUIRY, FOUNDER, now)!.revision).toBe(5);
  });

  it('a confirmed rebase and the founder own save both move the base to the loaded revision and end the warning', () => {
    const stale = { id: ENQUIRY, revision: 5 };
    expect(baseIsStale(stale, ENQUIRY, 9)).toBe(true);
    for (const kind of ['rebase', 'saved'] as const) {
      const revision = nextBaseRevision({ kind, loaded: 9 });
      expect(revision).toBe(9);
      expect(baseIsStale({ id: ENQUIRY, revision }, ENQUIRY, 9)).toBe(false);
    }
  });
  it('the warning belongs to the base, so an unrelated notice cannot clear it', () => {
    // Nothing but a new base clears it: the same inputs give the same answer however often it is asked.
    const stale = { id: ENQUIRY, revision: 5 };
    expect(baseIsStale(stale, ENQUIRY, 7)).toBe(true);
    expect(baseIsStale(stale, ENQUIRY, 7)).toBe(true);
    expect(baseIsStale(null, ENQUIRY, 7)).toBe(false);
  });

  it('a re-read keeps the base while edits are typed and follows the record when the form is clean', () => {
    expect(nextBaseRevision({ kind: 'refresh', previous: 5, loaded: 9, formDirty: true })).toBe(5);
    expect(nextBaseRevision({ kind: 'refresh', previous: 5, loaded: 9, formDirty: false })).toBe(9);
  });

  it('falls back to the revision on screen when the base belongs to another enquiry or is missing', () => {
    expect(expectedRevisionFor(null, ENQUIRY, 7)).toBe(7);
    expect(expectedRevisionFor({ id: 'other', revision: 3 }, ENQUIRY, 7)).toBe(7);
  });
});
