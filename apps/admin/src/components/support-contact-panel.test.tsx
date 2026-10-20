import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ContactChannels } from '@/lib/support/contact';
import type { ContactDeskView } from '@/lib/support/contact-browser';
import { ContactPanelView, emptyContactDrafts, type ContactPanelViewProps } from './support-contact-panel';

const record = (over: Partial<ContactChannels> = {}): ContactChannels => ({
  email: null,
  phone: null,
  chatHours: null,
  revision: 0,
  updatedAt: null,
  ...over,
});
const view = (data: ContactChannels = record()): ContactDeskView => ({
  asOf: '2026-10-20T04:00:00.000Z',
  contact: { kind: 'ok', data } as ContactDeskView['contact'],
});
const base = (over: Partial<ContactPanelViewProps> = {}): ContactPanelViewProps => ({
  view: view(),
  loading: false,
  form: { drafts: emptyContactDrafts, reason: '' },
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
const html = (p: ContactPanelViewProps) => renderToStaticMarkup(<ContactPanelView {...p} />);

describe('the support contact panel', () => {
  it('an unset channel reads "Not set" and nothing is invented', () => {
    const out = html(base());
    expect(out).toContain('data-testid="contact-current-email">Not set<');
    expect(out).toContain('data-testid="contact-current-phone">Not set<');
    expect(out).toContain('data-testid="contact-current-chatHours">Not set<');
    expect(out).toContain('Never');
  });
  it('shows what is stored and offers no save until something changes and a reason is given', () => {
    const stored = record({ email: 'help@example.test', revision: 3, updatedAt: '2026-10-19T10:00:00.000Z' });
    const out = html(base({ view: view(stored), form: { drafts: { email: 'help@example.test', phone: '', chatHours: '' }, reason: '' } }));
    expect(out).toContain('help@example.test');
    expect(out).toContain('Nothing has changed.');
    expect(out).toContain('disabled');
  });
  it('asks for a reason once something changed', () => {
    const out = html(base({ form: { drafts: { email: 'new@example.test', phone: '', chatHours: '' }, reason: '' } }));
    expect(out).toContain('Say why you are changing it.');
  });
  it('the confirm step names what changes and sends nothing itself', () => {
    const out = html(base({ armed: true, form: { drafts: { email: 'new@example.test', phone: '', chatHours: '' }, reason: 'new inbox' } }));
    expect(out).toContain('data-testid="confirm-step"');
    expect(out).toContain('Change support email?');
  });
  it('a refused read is shown as a refusal and the fields stay off', () => {
    const failed = { asOf: '2026-10-20T04:00:00.000Z', contact: { kind: 'failed', forbidden: true, message: 'denied', code: null } };
    const out = html(base({ view: failed as ContactDeskView }));
    expect(out).toContain('Contact details unavailable');
    expect(out).toContain('The current details could not be read.');
    expect(out).toContain('disabled=""');
  });
  it('a read that failed outright says so', () => {
    expect(html(base({ view: null }))).toContain('could not be read');
  });
  it('a saved answer names the new revision; an unknown answer is a warning, not a success', () => {
    const saved = html(base({ outcome: { ok: true, contact: record({ revision: 4 }) } }));
    expect(saved).toContain('revision 4');
    const unknown = html(
      base({
        outcome: {
          ok: false,
          refusal: { title: 'The outcome is not known', body: 'b', next: 'n', code: null, changed: 'unknown' },
        },
      }),
    );
    expect(unknown).toContain('data-tone="warn"');
    expect(unknown).not.toContain('Saved');
  });
});
