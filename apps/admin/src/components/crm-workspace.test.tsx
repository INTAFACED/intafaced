import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AliasNote,
  CrmWorkspace,
  aliasNamesOf,
  NEXT_ACTION_CHIPS,
  NextActionEditor,
  activityTitle,
  overdueLabel,
  pastDueWarning,
  quickDue,
  sourceLine,
} from './crm-workspace';
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

describe('next action history and editor', () => {
  const zone = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'UTC';
  });
  afterAll(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });
  const props = {
    description: 'Send the deck',
    due: '2026-10-16T09:00',
    unchanged: false,
    busy: false,
    onDescription: () => undefined,
    onDue: () => undefined,
    onSave: () => undefined,
    now,
  };

  it('words a next-action edit plainly, with the new text and due time, and never as a stage change', () => {
    const entry = activityTitle({ kind: 'next_action_changed', note: 'Send the deck', referenceId: '2026-10-16T09:00:00.000Z' }, owners);
    expect(entry.title).toBe('Next action changed');
    expect(entry.title).not.toMatch(/stage/i);
    // The shared formatter reads the founder's own clock, so assert the shape rather than a zone.
    expect(entry.note).toMatch(/^Send the deck · due 1[67] Oct 2026, \d{2}:\d{2}$/);
    expect(activityTitle({ kind: 'next_action_changed', note: 'Send the deck', referenceId: null }, owners).note).toBe('Send the deck');
    expect(activityTitle({ kind: 'next_action_changed', note: null, referenceId: 'not a date' }, owners)).toEqual({
      title: 'Next action changed',
      note: null,
    });
  });
  it('quick chips land on 09:00 local time, counted in calendar days', () => {
    expect(NEXT_ACTION_CHIPS.map((chip) => chip.label)).toEqual(['Tomorrow', '+3 days', 'Next week']);
    expect(quickDue(1, now)).toBe('2026-10-16T09:00');
    expect(quickDue(3, now)).toBe('2026-10-18T09:00');
    expect(quickDue(7, now)).toBe('2026-10-22T09:00');
    // Late in the evening, "tomorrow" is still the next calendar day.
    expect(quickDue(1, Date.parse('2026-10-15T23:50:00Z'))).toBe('2026-10-16T09:00');
    // Across a month end.
    expect(quickDue(3, Date.parse('2026-10-30T10:00:00Z'))).toBe('2026-11-02T09:00');
  });
  it('warns about a past due time but never blocks it', () => {
    expect(pastDueWarning('2026-10-14T09:00', now)).toMatch(/already passed/);
    expect(pastDueWarning('2026-10-15T09:00', now)).toMatch(/already passed/); // 09:00 is before 10:00 now
    expect(pastDueWarning('2026-10-15T11:00', now)).toBeNull();
    expect(pastDueWarning('', now)).toBeNull();
    expect(pastDueWarning('garbage', now)).toBeNull();
    const html = renderToStaticMarkup(<NextActionEditor {...props} due="2026-10-14T09:00" />);
    expect(html).toContain('already passed');
    expect(html).not.toContain('disabled=""><');
    expect(renderToStaticMarkup(<NextActionEditor {...props} />)).not.toContain('already passed');
  });
  it('asks for a description and a time, offers the three chips, and has no reason or stage field', () => {
    const html = renderToStaticMarkup(<NextActionEditor {...props} />);
    for (const text of ['What happens next', 'Due (your local time)', 'Tomorrow', '+3 days', 'Next week', 'Save next action'])
      expect(html).toContain(text);
    expect(html).toContain('value="Send the deck"');
    expect(html).toContain('value="2026-10-16T09:00"');
    expect(html).not.toMatch(/reason|stage|outcome|evidence/i);
  });
  it('keeps Save off until something changed, and while a save or an empty field is pending', () => {
    const save = (over: Partial<typeof props>) =>
      /<button type="submit"([^>]*)>/.exec(renderToStaticMarkup(<NextActionEditor {...props} {...over} />))![1]!;
    expect(save({})).not.toContain('disabled');
    expect(save({ unchanged: true })).toContain('disabled');
    expect(save({ busy: true })).toContain('disabled');
    expect(save({ description: '   ' })).toContain('disabled');
    expect(save({ due: '' })).toContain('disabled');
  });
});

describe('search through a merged contact', () => {
  it('maps each enquiry to the old name its search matched, and nothing when the page has none', () => {
    expect(aliasNamesOf(null).size).toBe(0);
    expect(aliasNamesOf({}).size).toBe(0);
    expect(aliasNamesOf({ aliasMatches: [{ opportunityId: 'o1', name: 'Augusta Byron' }] }).get('o1')).toBe('Augusta Byron');
  });
  it('says "also: <old name>" only when there is one, and shows it as text', () => {
    expect(renderToStaticMarkup(<AliasNote name="Augusta Byron" />)).toContain('also: Augusta Byron');
    expect(renderToStaticMarkup(<AliasNote name={undefined} />)).toBe('');
    expect(renderToStaticMarkup(<AliasNote name="<b>x</b>" />)).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('overdue and source wording', () => {
  // "Today" and "1 day" are local calendar days, so pin the zone these dates are written for.
  const zone = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'UTC';
  });
  afterAll(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });
  it('says "1 day" for an earlier calendar day even when under 24 hours have passed, and "today" only for the same day', () => {
    expect(overdueLabel('2026-10-14T23:30:00Z', now)).toBe('Overdue · 1 day'); // 10.5 hours ago, but yesterday
    expect(overdueLabel('2026-10-15T00:10:00Z', now)).toBe('Overdue · today');
  });
  it("formats counts with the en-GB locale, not the Mac's", () => {
    const spy = vi.spyOn(Number.prototype, 'toLocaleString');
    try {
      expect(overdueLabel('2023-01-01T00:00:00Z', now)).toBe('Overdue · 1,383 days');
      expect(spy).toHaveBeenCalledWith('en-GB');
    } finally {
      spy.mockRestore();
    }
  });
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
    expect(sessionStatus(at(-1), now)?.expired).toBe(true);
    expect(sessionStatus(at(8), now)?.expired).toBeUndefined();
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
