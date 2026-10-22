import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { emptyMergeForm } from '@/lib/support/merge';
import { TicketMergeView, type TicketMergeViewProps } from './support-ticket-merge';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const base = (over: Partial<TicketMergeViewProps> = {}): TicketMergeViewProps => ({
  ticket: { id: A, status: 'open' },
  form: emptyMergeForm,
  preview: null,
  reading: false,
  armed: false,
  busy: false,
  outcome: null,
  onField: () => undefined,
  onRead: () => undefined,
  onArm: () => undefined,
  onSend: () => undefined,
  ...over,
});
const html = (p: TicketMergeViewProps) => renderToStaticMarkup(<TicketMergeView {...p} />);
const readOk = {
  ok: true as const,
  preview: {
    sourceId: A,
    survivorId: B,
    refusal: null,
    commentsToMove: 3,
    attachmentsToMove: 0,
    staysOnSource: { rating: true, caseFile: false },
    alreadyMerged: false,
  },
};

describe('merge panel', () => {
  it('says it cannot be undone, and offers nothing to send before the preview is read', () => {
    const out = html(base());
    expect(out).toContain('It cannot be undone');
    expect(out).toMatch(/Review the merge<\/button>/);
    expect(out).toMatch(/disabled=""[^>]*>Review the merge/);
  });
  it('shows what would move and what stays once read', () => {
    const out = html(base({ form: { survivorId: B, reason: 'dup' }, preview: readOk }));
    expect(out).toContain('data-testid="merge-comments">3<');
    expect(out).toContain('data-testid="merge-files">0<');
    expect(out).toContain('its rating');
    expect(out).not.toMatch(/disabled=""[^>]*>Review the merge/);
  });
  it('names the refusal svc-support would give and keeps the button off', () => {
    const out = html(
      base({
        form: { survivorId: B, reason: 'dup' },
        preview: { ok: true, preview: { ...readOk.preview, refusal: 'support.merge_not_allowed' } },
      }),
    );
    expect(out).toContain('would refuse this merge');
    expect(out).toMatch(/disabled=""[^>]*>Review the merge/);
  });
  it('shows the second click with the irreversible wording once armed', () => {
    const out = html(base({ form: { survivorId: B, reason: 'dup' }, preview: readOk, armed: true }));
    expect(out).toContain('data-testid="confirm-step"');
    expect(out).toContain('This cannot be undone.');
    expect(out).toContain('Yes, merge them');
  });
  it('says a failed read is a failed read, not an empty preview', () => {
    const out = html(base({ form: { survivorId: B, reason: 'dup' }, preview: { ok: false, refusal: null } }));
    expect(out).toContain('merge-preview-failed');
    expect(out).not.toContain('merge-comments');
  });
  it('explains why a resolved or closed request cannot be merged', () => {
    expect(html(base({ ticket: { id: A, status: 'resolved' } }))).toContain('Only open, pending or on-hold requests can be merged');
    expect(html(base({ ticket: { id: A, status: 'resolved' } }))).not.toContain('sd-merge-survivor');
  });
  it('shows the link on a merged request instead of the form', () => {
    const out = html(base({ ticket: { id: A, status: 'closed', mergedInto: B } }));
    expect(out).toContain('data-testid="merge-done"');
    expect(out).not.toContain('sd-merge-survivor');
  });
});
