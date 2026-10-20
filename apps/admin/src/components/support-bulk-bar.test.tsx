import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { emptyBulkForm } from '@/lib/support/bulk';
import { SupportBulkBarView, type BulkBarViewProps } from './support-bulk-bar';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const base = (over: Partial<BulkBarViewProps> = {}): BulkBarViewProps => ({
  selected: [A, B],
  policy: { cap: 5 },
  policyFailed: null,
  roster: [],
  form: { ...emptyBulkForm, kind: 'status', status: 'resolved' },
  armed: false,
  busy: false,
  pending: false,
  reply: null,
  onField: () => undefined,
  onArm: () => undefined,
  onSend: () => undefined,
  onClear: () => undefined,
  ...over,
});
const html = (p: BulkBarViewProps) => renderToStaticMarkup(<SupportBulkBarView {...p} />);

describe('the bulk bar', () => {
  it('says how many are ticked and what the owner allows, and offers the change', () => {
    const out = html(base());
    expect(out).toContain('2 requests ticked.');
    expect(out).toContain('up to 5 requests at a time');
    expect(out).toContain('Change 2 requests');
    expect(out).not.toMatch(/Change 2 requests<\/button><span class="dk-why">/);
  });

  it('says the batch size is not set and offers nothing to send while it is blank', () => {
    const out = html(base({ policy: { cap: null } }));
    expect(out).toContain('data-testid="bulk-cap-unset"');
    expect(out).toContain('support.bulk_cap');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Change 2 requests/);
  });

  it('says plainly when the batch size could not be read', () => {
    const out = html(base({ policy: null, policyFailed: 'The batch size could not be read from svc-support, so nothing is sent.' }));
    expect(out).toContain('data-testid="bulk-policy-failed"');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Change 2 requests/);
  });

  it('is disabled with the reason when too many are ticked', () => {
    const out = html(base({ policy: { cap: 1 } }));
    expect(out).toContain('The owner allows 1 requests at a time; 2 are ticked.');
  });

  it('asks again before sending, and says what will happen', () => {
    const out = html(base({ armed: true }));
    expect(out).toContain('data-testid="confirm-step"');
    expect(out).toContain('set the status to resolved on 2 requests');
  });

  it('shows each request as svc-support answered it, with the reason for a refusal', () => {
    const out = html(
      base({
        reply: {
          ok: true,
          summary: 'svc-support changed 1, found 0 already there and refused 1 of 2 requests.',
          rows: [
            { ticketId: A, outcome: 'changed', code: null },
            { ticketId: B, outcome: 'refused', code: 'support.transition_illegal' },
          ],
        },
      }),
    );
    expect(out).toContain('data-testid="bulk-done"');
    expect(out).toContain('1 changed, 0 already there, 1 refused.');
    expect(out).toContain('Refused');
    expect(out).toContain('not allowed');
  });

  it('shows a refusal that changed nothing, and one whose outcome is unknown, as different tones', () => {
    const refusal = { title: 'The batch size is not set', body: 'b', next: 'n', code: 'support.bulk_cap_unset', changed: 'no' as const };
    expect(html(base({ reply: { ok: false, refusal } }))).toContain('data-tone="danger"');
    expect(html(base({ reply: { ok: false, refusal: { ...refusal, changed: 'unknown' } } }))).toContain('data-tone="warn"');
  });

  it('holds the change and says so while a send has no known answer, and sends the same change again', () => {
    const out = html(base({ pending: true }));
    expect(out).toContain('data-testid="bulk-pending"');
    expect(out).toContain('Send the same change again');
    expect(out).not.toContain('Untick all');
    expect(out).toMatch(/<select[^>]*id="sd-bulk-kind"[^>]*disabled=""/);
  });

  it('offers the staff list for an assignment, and says when it was not read', () => {
    const assign = { ...emptyBulkForm, kind: 'assign' as const };
    expect(html(base({ form: assign, roster: null }))).toContain('Staff list not read');
    const member = {
      userId: A,
      role: 'lead' as const,
      appointedBy: B,
      appointedAt: '2026-10-20T01:00:00.000Z',
      availability: 'online' as const,
      availabilitySetAt: null,
      lastHeartbeatAt: null,
    };
    expect(html(base({ form: assign, roster: [member] }))).toContain('(lead)');
  });
});
