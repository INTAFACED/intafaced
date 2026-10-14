import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CountsPanel, OtherCurrencies, RaiseBar, RaiseView } from './raise-view';
import { InboxView } from './inbox';
import { InboxRow } from './inbox-row';
import { AnswersColumn, FullAnswers, IdentityBar, NextActionColumn, Timeline, closeReason } from './person-parts';
import { DraftBlock, NextStepFields } from './person-sheets';
import { PeopleView } from './people-view';
import type { QueueEntry } from './queue';
import type { Detail, Metrics } from './request';
import { buildTimeline } from './timeline';
import { DEFAULT_CRM_SORT } from '@/lib/crm-list';

const zone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
});
afterAll(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

const NOW = Date.parse('2026-10-14T10:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const daysFromNow = (days: number) => new Date(NOW + days * 86_400_000).toISOString();
const NITRO = '11111111-1111-4111-8111-111111111111';
const PHANTOM = '22222222-2222-4222-8222-222222222222';
const owners = [
  { userId: NITRO, displayName: 'Nitro' as const },
  { userId: PHANTOM, displayName: 'Phantom' as const },
];

function entry(over: Record<string, unknown> = {}, name = 'Test Investor A'): QueueEntry {
  return {
    row: {
      id: String(over.id ?? 'a1'),
      contactId: 'c1',
      organisationId: null,
      submissionId: 's1',
      ownerUserId: NITRO,
      revision: 2,
      stage: 'new',
      audience: 'investor',
      nextAction: { description: 'Review enquiry', dueAt: daysFromNow(2) },
      closedDisposition: null,
      closingEvidenceRef: null,
      createdAt: hoursAgo(80),
      updatedAt: hoursAgo(80),
      indicativeContribution: { status: 'stated', amount: '250000', currency: 'EUR' },
      commitment: null,
      firstReplyAt: null,
      lastTouchAt: null,
      waitingSince: hoursAgo(50),
      ...over,
    } as unknown as QueueEntry['row'],
    contact: { id: 'c1', name, email: 'a@example.invalid' } as unknown as QueueEntry['contact'],
    organisation: 'Family Capital',
    partial: false,
  };
}

const inboxProps = {
  loading: false,
  error: '',
  truncated: false,
  tab: 'investors' as const,
  onTab: () => undefined,
  userId: NITRO,
  owners,
  selectedId: null,
  busy: false,
  onOpen: () => undefined,
  onRetry: () => undefined,
  info: new Map(),
  openEnquiries: 12,
  now: NOW,
};

describe('Inbox markup', () => {
  const entries = [
    entry(
      { id: 'overdue', waitingSince: hoursAgo(120), nextAction: { description: 'Send the deck', dueAt: hoursAgo(30) } },
      'Overdue Oscar',
    ),
    entry({ id: 'fresh', waitingSince: hoursAgo(3) }, 'Fresh Fiona'),
    entry(
      { id: 'trader', audience: 'trader', ownerUserId: PHANTOM, indicativeContribution: undefined, commitment: undefined },
      'Trader Tom',
    ),
  ];
  it('has the tabs with counts, investors first, and the three sections in order', () => {
    const html = renderToStaticMarkup(<InboxView {...inboxProps} entries={entries} />);
    expect(html).toContain('Investors');
    expect(html).toContain('Everyone else');
    expect(html).toContain('Mine');
    expect(html).toContain('All');
    expect(html).toContain('aria-label="Investors, 2 waiting"');
    expect(html).toContain('aria-label="Everyone else, 1 waiting"');
    expect(html).toContain('aria-label="All, 3 waiting"');
    expect(html.indexOf('Overdue Oscar')).toBeLessThan(html.indexOf('Fresh Fiona'));
    expect(html.indexOf('>Overdue<')).toBeLessThan(html.indexOf('No reply yet'));
    expect(html).not.toContain('Trader Tom');
  });
  it('shows the age with a word beside it when late, never colour alone', () => {
    const html = renderToStaticMarkup(<InboxView {...inboxProps} entries={entries} />);
    expect(html).toContain('5d');
    expect(html).toContain('Very late');
    expect(html).toContain('Waiting 5d, very late');
    expect(html).toContain('Waiting 3h');
  });
  it('shows the next action, and the overdue wording for one that is late', () => {
    const html = renderToStaticMarkup(<InboxView {...inboxProps} entries={entries} />);
    expect(html).toContain('Send the deck');
    expect(html).toMatch(/1 day overdue|2 days overdue/);
  });
  it('mutes the indicated amount and marks it self-reported', () => {
    const html = renderToStaticMarkup(<InboxView {...inboxProps} entries={entries} />);
    expect(html).toContain('€250k');
    expect(html).toContain('self-reported');
    expect(html).toContain('text-fg-2');
  });
  it('says nobody is waiting, with the number of open enquiries, when the queue is empty', () => {
    const html = renderToStaticMarkup(<InboxView {...inboxProps} entries={[]} />);
    expect(html).toContain('Nobody is waiting on you.');
    expect(html).toContain('12 open enquiries in total.');
  });
  it('shows a loading block before the queue arrives and an error with a retry when it cannot', () => {
    expect(renderToStaticMarkup(<InboxView {...inboxProps} entries={null} loading />)).toContain('aria-busy="true"');
    expect(renderToStaticMarkup(<InboxView {...inboxProps} entries={null} error="x" />)).toContain('Try again');
  });
  it('shows an Everyone else row with the audience and one key signal', () => {
    const trader = entry({ id: 'trader', audience: 'trader' }, 'Trader Tom');
    const html = renderToStaticMarkup(
      <InboxRow
        entry={trader}
        variant="other"
        info={{ answers: { role: 'community', timing: 'later' }, source: null }}
        founder="Phantom"
        now={NOW}
        selected={false}
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain('Trader');
    expect(html).toContain('Community leader');
    expect(html).toContain('Owner: Phantom');
  });
  it('shows an investor row with type, role, timing and source once the answers are in', () => {
    const html = renderToStaticMarkup(
      <InboxRow
        entry={entry()}
        variant="investor"
        info={{
          answers: { investorType: 'family_office', decisionRole: 'decision_maker', timing: 'within_three_months' },
          source: 'Deck N',
        }}
        founder="Nitro"
        now={NOW}
        selected
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain('Family office · Decision maker · ≤ 3 months · Deck N');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('data-enquiry-id="a1"');
  });
});

const metrics = {
  observedAt: hoursAgo(0),
  totals: {
    opportunities: 14,
    submissions: 14,
    canonicalContacts: 13,
    incompleteSubmissions: 3,
    overdueTasks: 1,
    manualCallInvitations: 2,
    manualCallBookings: 1,
  },
  byAudience: [],
  byStage: [
    { audience: 'investor', stage: 'new', count: 3 },
    { audience: 'investor', stage: 'qualified', count: 2 },
    { audience: 'trader', stage: 'new', count: 4 },
  ],
  bySource: [{ sourceKey: null, campaignId: null, count: 14 }],
  sourceGroupsTruncated: false,
  raise: {
    indicated: [
      { currency: 'EUR', amount: '1500000' },
      { currency: 'USD', amount: '50000' },
    ],
    softCircled: [{ currency: 'EUR', amount: '250000' }],
    committed: [{ currency: 'EUR', amount: '100000' }],
    counts: { indicated: 3, softCircled: 1, committed: 1, undecided: 1 },
  },
} as unknown as Metrics;

describe('Raise markup', () => {
  it('shows the target and the three levels as separate, labelled figures with percentages', () => {
    const html = renderToStaticMarkup(<RaiseBar raise={metrics.raise} />);
    expect(html).toContain('€5,000,000');
    expect(html).toContain('Committed');
    expect(html).toContain('€100,000');
    expect(html).toContain('2.0%');
    expect(html).toContain('Soft-circled');
    expect(html).toContain('€250,000');
    expect(html).toContain('5.0%');
    expect(html).toContain('Indicated');
    expect(html).toContain('€1,500,000');
    expect(html).toContain('30.0%');
    expect(html).toContain('self-reported');
  });
  it('fills the bar with committed only: the solid fill is 2%, the ghost 7% and the dotted outline 37%', () => {
    const html = renderToStaticMarkup(<RaiseBar raise={metrics.raise} />);
    expect(html).toContain('width:2%');
    expect(html).toContain('width:7%');
    expect(html).toContain('width:37%');
  });
  it('lists other currencies separately with the note "Not converted"', () => {
    const html = renderToStaticMarkup(<OtherCurrencies raise={metrics.raise} />);
    expect(html).toContain('Not converted');
    expect(html).toContain('USD');
    expect(html).toContain('$50,000');
    expect(renderToStaticMarkup(<OtherCurrencies raise={{ ...metrics.raise, indicated: [], softCircled: [], committed: [] }} />)).toBe('');
  });
  it('shows the stage strip as buttons, the tier counts as plain text, and the old report totals', () => {
    const html = renderToStaticMarkup(
      <RaiseView
        metrics={metrics}
        metricsError=""
        onRetry={() => undefined}
        stage="new"
        onStage={() => undefined}
        entries={[
          entry({
            id: 'x',
            commitment: { tier: 'soft_circled', amount: '250000', currency: 'EUR', recordedAt: hoursAgo(1), recordedBy: NITRO },
          }),
        ]}
        entriesLoading={false}
        owners={owners}
        selectedId={null}
        busy={false}
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Soft-circled');
    expect(html).toContain('Investors by stage');
    expect(html).toContain('No amount yet');
    expect(html).toContain('Where enquiries come from');
    expect(html).toContain('Unfinished questionnaires');
    expect(CountsPanel).toBeTypeOf('function');
  });
});

function detail(over: Record<string, unknown> = {}): Detail {
  const opportunity = { ...entry().row, ...over };
  return {
    opportunity,
    contact: {
      id: 'c1',
      name: 'Amara Okafor',
      email: 'amara@example.invalid',
      emailEvidence: { status: 'verified' },
      interests: ['investor', 'partner'],
    },
    organisation: { id: 'o1', name: 'Okafor Family Office', countries: ['SG'] },
    submission: {
      contact: {
        name: 'Amara Okafor',
        email: 'amara@example.invalid',
        organisationName: 'Okafor Family Office',
        country: 'SG',
        interests: ['investor', 'partner'],
        marketingOptIn: false,
      },
      questionnaires: [
        {
          audience: 'investor',
          answers: {
            investorType: 'family_office',
            participation: 'direct',
            decisionRole: 'decision_maker',
            indicativeContribution: { status: 'stated', amount: '250000', currency: 'EUR' },
            timing: 'within_three_months',
            message: 'We back payments infrastructure.',
          },
        },
      ],
      capturedAt: hoursAgo(50),
      completedAt: hoursAgo(49),
    },
    activities: [],
    tasks: [],
    provenance: {},
  } as unknown as Detail;
}

describe('Person markup', () => {
  const headingRef = { current: null };
  it('shows who they are, whose move it is, the owner, the stage and the tier above the fold', () => {
    const html = renderToStaticMarkup(<IdentityBar detail={detail()} founder="Nitro" now={NOW} headingRef={headingRef} />);
    expect(html).toContain('Amara Okafor');
    expect(html).toContain('Okafor Family Office');
    expect(html).toContain('Singapore');
    expect(html).toContain('Email verified');
    expect(html).toContain('Investor');
    expect(html).toContain('Partner');
    expect(html).toContain('No reply yet');
    expect(html).toContain('Owner');
    expect(html).toContain('Stage');
    expect(html).toContain('Indicated');
    expect(html).toContain('id="crm-detail-heading"');
  });
  it('shows the key answers worded, the amount marked self-reported, and the message quoted (fix G9, G7)', () => {
    const d = detail();
    const html = renderToStaticMarkup(
      <AnswersColumn detail={d} answers={d.submission.questionnaires[0]!.answers as never} source="Deck N" />,
    );
    expect(html).toContain('€250,000');
    expect(html).toContain('self-reported');
    expect(html).toContain('Family office');
    expect(html).toContain('Decision maker');
    expect(html).toContain('Within 3 months');
    expect(html).toContain('Deck N');
    expect(html).toContain('<blockquote');
    expect(html).toContain('We back payments infrastructure.');
    expect(html).not.toMatch(/family_office|decision_maker|within_three_months/);
  });
  it('shows a closed enquiry’s outcome, reason and evidence (fix G10)', () => {
    const closed = detail({
      stage: 'closed',
      nextAction: null,
      closedDisposition: 'declined',
      closingEvidenceRef: 'Decline reply sent by email on 14 Oct 2026 by Nitro',
      waitingSince: null,
    });
    closed.activities = [
      {
        id: 'x',
        opportunityId: 'a1',
        sequence: 4,
        kind: 'stage_changed',
        actor: { kind: 'operator', userId: NITRO },
        note: 'Not a fit now',
        referenceId: null,
        occurredAt: hoursAgo(1),
        fromStage: 'new',
        toStage: 'closed',
      },
    ] as never;
    const html = renderToStaticMarkup(
      <NextActionColumn
        detail={closed}
        now={NOW}
        owners={owners}
        founder="Nitro"
        otherName="Phantom"
        busy={false}
        onChange={() => undefined}
        onHandOver={() => undefined}
        onCommitment={() => undefined}
      />,
    );
    expect(html).toContain('Closed as');
    expect(html).toContain('Declined');
    expect(html).toContain('Not a fit now');
    expect(html).toContain('Decline reply sent by email on 14 Oct 2026 by Nitro');
    expect(html).not.toContain('Change</button>');
    expect(closeReason(closed.activities)).toBe('Not a fit now');
  });
  it('shows the next action and the commitment beside the owner for an open investor', () => {
    const open = detail({
      commitment: {
        tier: 'soft_circled',
        amount: '250000',
        currency: 'EUR',
        recordedAt: hoursAgo(2),
        recordedBy: NITRO,
        evidenceRef: 'Call 14 Oct',
      },
    });
    const html = renderToStaticMarkup(
      <NextActionColumn
        detail={open}
        now={NOW}
        owners={owners}
        founder="Nitro"
        otherName="Phantom"
        busy={false}
        onChange={() => undefined}
        onHandOver={() => undefined}
        onCommitment={() => undefined}
      />,
    );
    expect(html).toContain('Review enquiry');
    expect(html).toContain('Hand to Phantom');
    expect(html).toContain('Soft-circled €250,000');
    expect(html).toContain('Call 14 Oct');
    expect(html).toContain('Change commitment');
  });
  it('lists every answer under Full answers, worded', () => {
    const html = renderToStaticMarkup(<FullAnswers detail={detail()} />);
    expect(html).toContain('Investor type');
    expect(html).toContain('Takes part');
    expect(html).toContain('Message');
  });
  it('puts a note composer above one timeline that reads "New → Qualified"', () => {
    const items = buildTimeline({
      owners,
      messages: [],
      activities: [
        {
          id: 'n',
          sequence: 2,
          kind: 'stage_changed',
          actor: { kind: 'operator', userId: NITRO },
          note: 'Reviewed: fits',
          referenceId: null,
          occurredAt: hoursAgo(1),
          fromStage: 'new',
          toStage: 'qualified',
        },
        {
          id: 'q',
          sequence: 1,
          kind: 'questionnaire_submitted',
          actor: { kind: 'prospect', submissionId: PHANTOM },
          note: null,
          referenceId: null,
          occurredAt: hoursAgo(5),
        },
      ] as never,
    });
    const html = renderToStaticMarkup(
      <Timeline items={items} note="" onNote={() => undefined} onAddNote={() => undefined} busy={false} composerRef={{ current: null }} />,
    );
    expect(html).toContain('New → Qualified');
    expect(html).toContain('Reviewed: fits');
    expect(html).toContain('Questionnaire submitted');
    expect(html.indexOf('Add a note')).toBeLessThan(html.indexOf('New → Qualified'));
  });
});

describe('Reply sheet pieces', () => {
  it('headers the draft as awaiting Nitro’s approval and offers the mail app link and Copy text', () => {
    const html = renderToStaticMarkup(
      <DraftBlock
        draft={{ subject: 'Your INTAFACED enquiry', body: 'Hi Amara,\n\nThanks' }}
        email="amara@example.invalid"
        onDraft={() => undefined}
      />,
    );
    expect(html).toContain('DRAFT: awaiting Nitro&#x27;s approval of wording');
    expect(html).toContain('Open in my email app');
    expect(html).toContain(
      'href="mailto:amara@example.invalid?subject=Your%20INTAFACED%20enquiry&amp;body=Hi%20Amara%2C%0D%0A%0D%0AThanks"',
    );
    expect(html).toContain('Copy text');
  });
  it('offers next-step chips, due chips and a datetime field', () => {
    const html = renderToStaticMarkup(
      <NextStepFields
        description="Wait for their reply"
        due="2026-10-19T09:00"
        onDescription={() => undefined}
        onDue={() => undefined}
        idPrefix="x"
      />,
    );
    for (const text of ['Wait for their reply', 'Schedule a call', 'Send follow-up', 'Review answers', 'Tomorrow', '+3 days', 'Next week'])
      expect(html).toContain(text);
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain('aria-pressed="true"');
  });
});

describe('People markup', () => {
  it('keeps the search, filters and sort, and says the search covers name and email', () => {
    const html = renderToStaticMarkup(
      <PeopleView
        entries={[entry({}, 'Test Investor A')]}
        loading={false}
        error=""
        filters={{ audience: '', stage: '', owner: '', query: '' }}
        onFilters={() => undefined}
        sort={DEFAULT_CRM_SORT}
        onSort={() => undefined}
        owners={owners}
        selectedId={null}
        busy={false}
        onOpen={() => undefined}
        onRetry={() => undefined}
        hasNext={false}
        hasPrevious={false}
        onNext={() => undefined}
        onPrevious={() => undefined}
        now={NOW}
      />,
    );
    expect(html).toContain('placeholder="Search name or email"');
    expect(html).toContain('aria-label="Audience"');
    expect(html).toContain('aria-label="Stage"');
    expect(html).toContain('aria-label="Owner"');
    expect(html).toContain('aria-label="Sort by"');
    expect(html).toContain('Test Investor A');
  });
});
