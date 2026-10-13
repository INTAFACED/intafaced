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
  it('hides a stale "Saved" or "retained" line behind an error', () => {
    expect(detailNotices({ ...base, error: 'Could not save', notice: 'Saved to the enquiry history.', dirty: true })).toEqual(['error']);
  });
});
