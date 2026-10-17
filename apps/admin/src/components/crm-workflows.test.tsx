import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { crmMergeInputSchema } from '@intafaced/contracts';
import {
  CrmMetrics,
  CrmTasks,
  StaleNote,
  MergeCard,
  chooseKeep,
  mergeInput,
  PastDateWarning,
  TaskRow,
  csvCell,
  dueText,
  groupDuplicates,
  kindLabel,
  mergeSummary,
  sortTasks,
  submissionsToCsv,
  type EnquiryBrief,
} from './crm-workflows';
import { MessageItem, statusText } from './crm-messages';

const NOW = Date.parse('2026-10-13T08:00:00Z');
const day = 86400000;
const due = (offset: number) => new Date(NOW + offset).toISOString();
const owners = [
  { userId: 'u1', displayName: 'Nitro' as const },
  { userId: 'u2', displayName: 'Phantom' as const },
];
const brief = (over: Partial<EnquiryBrief> = {}): EnquiryBrief => ({
  id: 'o1',
  contactId: 'c1',
  contactName: 'Test Investor A',
  email: 'a@example.invalid',
  organisation: 'Acme Capital',
  audience: 'investor',
  stage: 'new',
  ownerUserId: 'u1',
  receivedAt: '2026-10-13T05:00:00Z',
  amount: '25,000 USD',
  ...over,
});

describe('follow-ups queue', () => {
  it('sorts overdue first, then by due date, finished tasks last', () => {
    const rows = [
      { id: 'later', task: { status: 'pending', dueAt: due(3 * day) } },
      { id: 'done', task: { status: 'completed', dueAt: due(-9 * day) } },
      { id: 'soon', task: { status: 'pending', dueAt: due(day) } },
      { id: 'late2', task: { status: 'pending', dueAt: due(-2 * day) } },
      { id: 'late5', task: { status: 'pending', dueAt: due(-5 * day) } },
    ];
    expect(sortTasks(rows, NOW).map((row) => row.id)).toEqual(['late5', 'late2', 'soon', 'later', 'done']);
  });

  it('words due dates plainly, in local calendar days (never hours) and in the same words as the list and the open enquiry', () => {
    // NOW is 08:00 UTC. Pin the clock zone so "yesterday" means the same day everywhere this runs.
    const zone = process.env.TZ;
    process.env.TZ = 'UTC';
    try {
      expect(dueText({ status: 'pending', dueAt: due(-2 * day - 1000) }, NOW)).toEqual({ text: '2 days overdue', overdue: true });
      expect(dueText({ status: 'pending', dueAt: due(-day - 1000) }, NOW)?.text).toBe('1 day overdue');
      expect(dueText({ status: 'pending', dueAt: due(-3 * 3600000) }, NOW)?.text).toBe('Overdue today');
      expect(dueText({ status: 'pending', dueAt: due(3 * day + 60000) }, NOW)).toEqual({ text: 'Due in 3 days', overdue: false });
      expect(dueText({ status: 'completed', dueAt: due(-day) }, NOW)).toBeNull();
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  it('shows who the follow-up is for and flags overdue', () => {
    const item = {
      task: {
        id: 't1',
        opportunityId: 'o1',
        ownerUserId: 'u2',
        description: 'Send deck',
        dueAt: due(-2 * day - 1000),
        status: 'pending',
        updatedAt: due(0),
      },
      revision: 1,
      kind: 'call_invitation',
      createdAt: null,
    } as never;
    const html = renderToStaticMarkup(
      <TaskRow item={item} brief={brief()} loading={false} owners={owners} onOpen={() => undefined} now={NOW} />,
    );
    expect(html).toContain('Test Investor A');
    expect(html).toContain('Acme Capital · Investor');
    expect(html).toContain('2 days overdue');
    expect(html).toContain('is-overdue');
    expect(html).toContain('Call invitation');
    expect(html).toContain('Phantom');
    expect(html).not.toContain('call_invitation');
  });

  it('says when contact details cannot be found instead of leaving a blank', () => {
    const item = {
      task: { id: 't1', opportunityId: 'o1', ownerUserId: 'u1', description: 'x', dueAt: due(day), status: 'pending', updatedAt: due(0) },
      revision: 1,
      kind: 'follow_up',
      createdAt: null,
    } as never;
    expect(
      renderToStaticMarkup(<TaskRow item={item} brief={null} loading={false} owners={owners} onOpen={() => undefined} now={NOW} />),
    ).toContain('Contact details unavailable');
  });
});

describe('summary counts', () => {
  it('makes overdue a button and only makes the other counts buttons when wired', () => {
    const plain = renderToStaticMarkup(<CrmMetrics filters={{}} onTasks={() => undefined} />);
    expect(plain).toMatch(/<button[^>]*class="crm-wf-count[^"]*"[^>]*>— overdue<\/button>/);
    expect(plain).not.toMatch(/<button[^>]*>— incomplete/);
    const wired = renderToStaticMarkup(
      <CrmMetrics
        filters={{}}
        onTasks={() => undefined}
        onIncomplete={() => undefined}
        onInvitations={() => undefined}
        onOverdue={() => undefined}
      />,
    );
    expect(wired).toMatch(/<button[^>]*>— incomplete<\/button>/);
    expect(wired).toMatch(/<button[^>]*>— invitations<\/button>/);
  });
});

describe('quiet reload failure and overdue wording', () => {
  it('shows a small note, not an alert, beside figures that stayed on screen', () => {
    const html = renderToStaticMarkup(<StaleNote error="We could not confirm the request." />);
    expect(html).toContain('Couldn&#x27;t refresh just now. Showing the last figures we have.');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
    expect(renderToStaticMarkup(<StaleNote error="" />)).toBe('');
  });

  it('explains why the overdue list can be longer than the filtered count, only when it was opened from the count with filters on', () => {
    const open = (initialOverdue: boolean, filtersActive: boolean) =>
      renderToStaticMarkup(
        <CrmTasks owners={owners} onOpen={() => undefined} initialOverdue={initialOverdue} filtersActive={filtersActive} />,
      );
    expect(open(true, true)).toContain('This list covers every audience, stage and owner');
    expect(open(true, false)).not.toContain('every audience');
    expect(open(false, true)).not.toContain('every audience');
  });
});

describe('merge direction', () => {
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const card = (id: string) => ({ contact: { id } });

  it('keeps the card the founder clicked: its contact id is the target, the other card is the source', () => {
    expect(chooseKeep([card(A), card(B)], card(B))).toEqual({ target: B, source: A });
    expect(chooseKeep([card(A), card(B)], card(A))).toEqual({ target: A, source: B });
  });

  it('with three or more records only the kept one is set; the founder picks the one to fold in', () => {
    expect(chooseKeep([card(A), card(B), card(C)], card(B))).toEqual({ target: B, source: '' });
  });

  it('sends the kept contact as targetContactId with ITS revision, and the folded one as sourceContactId, in the shape the contract accepts', () => {
    const { target, source } = chooseKeep([card(A), card(B)], card(B));
    const input = mergeInput(source, target, 2, 7, 'Same person');
    expect(input).toMatchObject({ targetContactId: B, targetExpectedRevision: 7, sourceContactId: A, sourceExpectedRevision: 2 });
    expect(crmMergeInputSchema.safeParse({ ...input, requestId: C }).success).toBe(true);
  });
});

describe('merge', () => {
  const contact = (name: string, id: string) =>
    ({
      id,
      name,
      email: 'a@example.invalid',
      emailEvidence: { status: 'unverified' },
      interests: ['investor'],
      createdAt: '2026-10-13T05:00:00Z',
    }) as never;

  it('groups candidates that share an email, ignoring case', () => {
    const groups = groupDuplicates([
      { contact: { email: 'A@x.test' } },
      { contact: { email: 'b@x.test' } },
      { contact: { email: 'a@x.test' } },
    ]);
    expect(groups.map((g) => g.length)).toEqual([2, 1]);
  });

  it('puts what a founder needs on each card', () => {
    const html = renderToStaticMarkup(
      <MergeCard
        contact={contact('Test Investor A', 'c1')}
        briefs={[brief()]}
        owners={owners}
        role="keep"
        groupLoaded
        onKeep={() => undefined}
      />,
    );
    for (const text of [
      'Test Investor A',
      'a@example.invalid',
      'Acme Capital',
      'Investor',
      'New',
      'Nitro',
      '13 Oct 2026',
      '25,000 USD',
      'Keeping this one',
    ])
      expect(html).toContain(text);
    expect(html).toContain('aria-pressed="true"');
  });

  it('falls back to the contact itself when the enquiry is not in the loaded window', () => {
    const html = renderToStaticMarkup(
      <MergeCard contact={contact('Old Contact', 'c9')} briefs={[]} owners={owners} role={null} groupLoaded onKeep={() => undefined} />,
    );
    expect(html).toContain('Not in the 200 newest enquiries');
    expect(html).toContain('Click to keep this one');
  });

  it('summarises the merge plainly and says it cannot be undone', () => {
    const text = mergeSummary(contact('Test Investor A', 'c1'), [brief()], contact('Test Investor B', 'c2'), [
      brief({ id: 'o2', contactId: 'c2' }),
    ]);
    expect(text).toContain('Keep Test Investor A (received 13 Oct 2026, Investor, New)');
    expect(text).toContain('Fold in Test Investor B');
    expect(text).toContain('1 enquiry from Test Investor B will move to Test Investor A');
    expect(text).toContain("This can't be undone.");
  });
});

describe('dates', () => {
  it('warns about a past date but only a past date', () => {
    expect(renderToStaticMarkup(<PastDateWarning value="2026-10-01T09:00" now={NOW} />)).toContain('That date is in the past');
    expect(renderToStaticMarkup(<PastDateWarning value="2026-10-20T09:00" now={NOW} />)).toBe('');
    expect(renderToStaticMarkup(<PastDateWarning value="" now={NOW} />)).toBe('');
  });
});

describe('csv export', () => {
  it('escapes quotes, commas and line breaks', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('neutralises spreadsheet formulas', () => {
    for (const bad of ['=SUM(A1)', '+1', '-1', '@cmd', '=HYPERLINK("http://x","y")']) expect(csvCell(bad).replace(/^"/, '')).toMatch(/^'/);
    expect(csvCell('=1,2')).toBe(`"'=1,2"`);
    expect(csvCell('plain')).toBe('plain');
  });

  it('writes one line per submission under a header', () => {
    const item = {
      submission: {
        submissionId: 's1',
        capturedAt: '2026-10-13T05:00:00Z',
        completedAt: null,
        contact: { name: '=Evil', email: 'e@x.test', organisationName: 'Acme, Inc', interests: ['investor', 'partner'] },
        questionnaires: [{ audience: 'investor' }],
      },
      initialContact: { marketingOptIn: true },
      firstCompletedAt: null,
      canonicalContact: { name: 'Canon', email: 'c@x.test' },
      attribution: { campaign: { name: 'Deck A', channel: 'deck' }, sourceHint: 'abc' },
    };
    const csv = submissionsToCsv({ items: [item, item] } as never);
    const lines = csv.replace('﻿', '').trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^submission_id,captured_at,/);
    expect(lines[1]).toContain("'=Evil");
    expect(lines[1]).toContain('"Acme, Inc"');
    expect(lines[1]).toContain('investor; partner');
  });
});

describe('plain wording', () => {
  it('labels task and message kinds', () => {
    expect(kindLabel('call_invitation')).toBe('Call invitation');
    expect(kindLabel('information_request')).toBe('Information request');
    expect(kindLabel('next_action')).toBe('Next action');
  });

  it('uses plain delivery wording', () => {
    expect(statusText.pending).toBe('Saved, not emailed yet');
    for (const text of Object.values(statusText)) expect(text).not.toMatch(/dispatch|gateway|durable|queue/i);
  });

  it('shows a message with its plain kind, and the text the founder wrote when it is stored', () => {
    const base = {
      id: 'm1',
      opportunityId: 'o1',
      submissionId: 's1',
      kind: 'call_invitation',
      staffText: null,
      actorUserId: 'u1',
      status: 'pending',
      createdAt: '2026-10-13T05:00:00Z',
      notification: null,
    } as const;
    const without = renderToStaticMarkup(<MessageItem message={base} owners={owners} />);
    expect(without).toContain('Call invitation');
    expect(without).not.toContain('call_invitation');
    expect(without).not.toContain('adm-message-text');
    const withText = renderToStaticMarkup(
      <MessageItem message={{ ...base, staffText: 'Could you join a call on Friday?' }} owners={owners} />,
    );
    expect(withText).toContain('Could you join a call on Friday?');
    expect(withText).toContain('adm-message-text');
    // Text is shown as text, never as markup.
    const hostile = renderToStaticMarkup(<MessageItem message={{ ...base, staffText: '<img src=x onerror=alert(1)>' }} owners={owners} />);
    expect(hostile).not.toContain('<img');
    expect(hostile).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
