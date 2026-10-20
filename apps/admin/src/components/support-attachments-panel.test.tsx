import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ATTACHMENT_KEYS, emptyAttachmentDrafts, type AttachmentLimits, type AttachmentStatus } from '@/lib/support/attachments';
import type { AttachmentsDeskView } from '@/lib/support/attachments-browser';
import { AttachmentsPanelView, type AttachmentsPanelViewProps } from './support-attachments-panel';

const limits = (over: Partial<AttachmentLimits> = {}): AttachmentLimits => ({
  maxBytes: null,
  allowedTypes: null,
  maxCount: null,
  missing: 'support.attachment_store',
  revision: 0,
  updatedAt: null,
  ...over,
});
const status = (over: Partial<AttachmentLimits> = {}, set: boolean[] = [false, false, false, false, false]): AttachmentStatus => ({
  pieces: ATTACHMENT_KEYS.map((key, i) => ({ key, set: set[i]! })),
  limits: limits(over),
});
const view = (data: AttachmentStatus = status()): AttachmentsDeskView => ({
  asOf: '2026-10-20T04:00:00.000Z',
  status: { kind: 'ok', data } as AttachmentsDeskView['status'],
});
const base = (over: Partial<AttachmentsPanelViewProps> = {}): AttachmentsPanelViewProps => ({
  view: view(),
  loading: false,
  form: { drafts: emptyAttachmentDrafts, reason: '' },
  armed: false,
  busy: false,
  outcome: null,
  onDraft: () => undefined,
  onReason: () => undefined,
  onArm: () => undefined,
  onSend: () => undefined,
  onRefresh: () => undefined,
  ...over,
});
const html = (p: AttachmentsPanelViewProps) => renderToStaticMarkup(<AttachmentsPanelView {...p} />);

describe('the support attachments panel', () => {
  it('shows every piece as not set with its missing key, and invents no limit', () => {
    const out = html(base());
    for (const key of ATTACHMENT_KEYS) {
      expect(out).toContain(`data-testid="attachments-piece-${key}" data-set="no"`);
      expect(out).toContain(`<code>${key}</code>`);
    }
    for (const s of ['maxBytes', 'allowedTypes', 'maxCount']) expect(out).toContain(`data-testid="attachments-current-${s}">Not set<`);
    expect(out).toContain('Never');
  });
  it('shows a set piece without a missing key and the stored limits', () => {
    const stored = status(
      { maxBytes: 1000, allowedTypes: ['image/png', 'application/pdf'], maxCount: 3, missing: 'support.attachment_store', revision: 2 },
      [false, false, true, true, true],
    );
    const out = html(base({ view: view(stored) }));
    expect(out).toContain('data-testid="attachments-piece-support.attachment_max_bytes" data-set="yes"');
    expect(out).not.toContain('<code>support.attachment_max_bytes</code>');
    expect(out).toContain('data-testid="attachments-current-maxBytes">1000<');
    expect(out).toContain('image/png, application/pdf');
  });
  it('offers no save until something changes and a reason is given', () => {
    expect(html(base())).toContain('Nothing has changed.');
    const changed = { maxBytes: '100', allowedTypes: '', maxCount: '' };
    expect(html(base({ form: { drafts: changed, reason: '' } }))).toContain('Say why you are changing it.');
    expect(html(base({ form: { drafts: { ...changed, maxBytes: 'abc' }, reason: 'r' } }))).toContain('must be a whole number');
  });
  it('the confirm step names what changes and sends nothing itself', () => {
    const out = html(base({ armed: true, form: { drafts: { maxBytes: '100', allowedTypes: '', maxCount: '' }, reason: 'first limit' } }));
    expect(out).toContain('data-testid="confirm-step"');
    expect(out).toContain('Change largest file, in bytes?');
  });
  it('a refused read is shown as a refusal and the fields stay off', () => {
    const failed = { asOf: '2026-10-20T04:00:00.000Z', status: { kind: 'failed', forbidden: true, message: 'denied', code: null } };
    const out = html(base({ view: failed as AttachmentsDeskView }));
    expect(out).toContain('Attachment settings unavailable');
    expect(out).toContain('The current limits could not be read.');
    expect(out).toContain('disabled=""');
  });
  it('a read that failed outright says so', () => {
    expect(html(base({ view: null }))).toContain('could not be read');
  });
  it('a saved answer names the new revision; an unknown answer is a warning, not a success', () => {
    const saved = html(base({ outcome: { ok: true, limits: limits({ revision: 4 }) } }));
    expect(saved).toContain('revision 4');
    expect(saved).toContain('data-tone="ok"');
    const unknown = html(
      base({
        outcome: { ok: false, refusal: { title: 'The outcome is not known', body: 'b', next: 'n', code: null, changed: 'unknown' } },
      }),
    );
    expect(unknown).toContain('data-tone="warn"');
    expect(unknown).not.toContain('Saved');
  });
});
