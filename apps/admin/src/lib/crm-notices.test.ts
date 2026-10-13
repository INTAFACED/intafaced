import { describe, expect, it } from 'vitest';
import { RESTORED_EDITS_NOTICE, detailNotices } from './crm-notices';

const base = { error: '', notice: '', stale: false, dirty: false };

describe('enquiry notice area', () => {
  it('shows nothing when there is nothing to say', () => {
    expect(detailNotices(base)).toEqual([]);
  });
  it('shows the quiet "retained" hint only when nothing else is showing', () => {
    expect(detailNotices({ ...base, dirty: true })).toEqual(['retained']);
    expect(detailNotices({ ...base, dirty: true, notice: RESTORED_EDITS_NOTICE })).toEqual(['notice']);
  });
  it('lets the stale warning replace the saved, restored and retained notices instead of adding to them', () => {
    expect(detailNotices({ ...base, stale: true, dirty: true, notice: RESTORED_EDITS_NOTICE })).toEqual(['stale']);
  });
  it('keeps the stale warning next to a refused save, error first', () => {
    expect(detailNotices({ ...base, error: 'The enquiry changed', stale: true, dirty: true })).toEqual(['error', 'stale']);
  });
  it('folds a conflict error into one stale warning that leads with the refused save', () => {
    expect(detailNotices({ ...base, error: 'The enquiry changed', errorKind: 'conflict', stale: true, dirty: true })).toEqual([
      'stale_refused',
    ]);
  });
  it('still shows a non-conflict error next to the stale warning', () => {
    for (const errorKind of ['other', 'session'] as const)
      expect(detailNotices({ ...base, error: 'Server error', errorKind, stale: true, dirty: true })).toEqual(['error', 'stale']);
  });
  it('shows a conflict error as before when the draft is not stale', () => {
    expect(detailNotices({ ...base, error: 'The enquiry changed', errorKind: 'conflict', dirty: true })).toEqual(['error']);
  });
  it('keeps the blocked message beside the folded stale warning', () => {
    expect(detailNotices({ ...base, error: 'x', errorKind: 'conflict', stale: true, blocked: true })).toEqual(['blocked', 'stale_refused']);
  });
  it('hides a stale "Saved" or "retained" line behind an error', () => {
    expect(detailNotices({ ...base, error: 'Could not save', notice: 'Saved to the enquiry history.', dirty: true })).toEqual(['error']);
  });
  it('never hides the message that explains a refused click, whatever else is showing', () => {
    expect(detailNotices({ ...base, blocked: true })).toEqual(['blocked']);
    expect(detailNotices({ ...base, blocked: true, stale: true, dirty: true })).toEqual(['blocked', 'stale']);
    expect(detailNotices({ ...base, blocked: true, error: 'Could not save', notice: 'Saved to the enquiry history.' })).toEqual([
      'error',
      'blocked',
    ]);
  });
});
