import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CrmWorkspace, activityTitle, overdueLabel, sourceLine } from './crm-workspace';
import { sessionStatus } from './founder-session-bar';

const owners = [
  { userId: 'u-nitro', displayName: 'Nitro' },
  { userId: 'u-phantom', displayName: 'Phantom' },
];
const now = Date.parse('2026-10-15T10:00:00Z');

describe('activity log wording', () => {
  it('says who an enquiry was assigned to, using the referenceId', () => {
    expect(activityTitle({ kind: 'assigned', note: null, referenceId: 'u-phantom' }, owners).title).toBe('Assigned to Phantom');
    expect(activityTitle({ kind: 'assigned', note: null, referenceId: 'unknown' }, owners).title).toBe('Owner assigned');
  });
  it('turns a queued message kind into plain words and never shows the raw kind', () => {
    const entry = activityTitle({ kind: 'email_status', note: 'Message queued: call_invitation', referenceId: 'x' }, owners);
    expect(entry).toEqual({ title: 'Message queued: Call invitation', note: null });
  });
  it('does not call a reason-only log entry a stage change', () => {
    const entry = activityTitle({ kind: 'stage_changed', note: 'Moved the call', referenceId: 'req' }, owners);
    expect(entry.title).not.toMatch(/^Stage changed/);
    expect(entry.note).toBe('Moved the call');
  });
});

describe('overdue and source wording', () => {
  it('labels overdue days, today, and nothing for the future', () => {
    expect(overdueLabel('2026-10-13T09:00:00Z', now)).toBe('Overdue · 2 days');
    expect(overdueLabel('2026-10-14T09:00:00Z', now)).toBe('Overdue · 1 day');
    expect(overdueLabel('2026-10-15T08:00:00Z', now)).toBe('Overdue · today');
    expect(overdueLabel('2026-10-16T08:00:00Z', now)).toBeNull();
  });
  it('hides an unknown source and collapses identical ones', () => {
    expect(sourceLine(undefined, null)).toBeNull();
    expect(sourceLine('Deck', 'Deck')).toBe('Source: Deck');
    expect(sourceLine('Deck', 'Email')).toBe('Source: Deck · latest Email');
    expect(sourceLine(null, 'Email')).toBe('Source: Email');
  });
});

describe('session bar clock', () => {
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
  it('shows nothing before the browser mounts, then the end time, then a warning from 10 minutes out', () => {
    expect(sessionStatus(at(60), null)).toBeNull();
    expect(sessionStatus(at(60), now)).toMatchObject({ warning: false, text: expect.stringMatching(/^Session ends \d{2}:\d{2}$/) });
    expect(sessionStatus(at(8), now)).toEqual({ warning: true, text: 'Session ends in 8 min — save your work' });
    expect(sessionStatus(at(10), now)?.warning).toBe(true);
    expect(sessionStatus(at(-1), now)?.warning).toBe(true);
  });
});

describe('workspace shell', () => {
  it('offers a skip link, a Filters button for phones, and one Enquiries title and tab', () => {
    const html = renderToStaticMarkup(<CrmWorkspace csrf="csrf" />);
    expect(html).toContain('Skip to enquiries');
    expect(html).toContain('adm-filters-toggle');
    expect(html).toContain('id="crm-enquiries"');
    expect(html.match(/>Enquiries</g)?.length).toBe(2);
    expect(html).not.toContain('Sign in');
  });
});
