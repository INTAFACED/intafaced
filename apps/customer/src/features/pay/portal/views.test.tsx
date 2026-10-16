import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no external store snapshot for the language preference; read it directly.
vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import type { ReactElement } from 'react';
import type { ApiResult } from '../../../shared/api';
import type { Resource } from '../../../shared/resource';
import type { PortalApi } from './api';
import { CustomerDetailView, CustomersView } from './Customers';
import { DashboardInsights as DashboardView, type DashboardData } from './Dashboard';
import { DisputeDetailView, DisputesView } from './Disputes';
import { ExportsView } from './Exports';
import type { ListState } from './hooks';
import { NotificationsView } from './Notifications';
import { OnboardingView } from './Onboarding';
import { TeamView } from './Team';
import * as p from './schemas';

// Everything below is TEST DATA written for these tests. None of it is a real merchant, customer or amount.
const portal = {} as PortalApi;
const html = (node: ReactElement) => renderToString(node);
const loading = { status: 'loading' } as const;
const ready = <T,>(data: T): Resource<T> => ({ status: 'ready', data });
type Refusal = Extract<ApiResult<never>, { ok: false }>;
const refusal = (code: string, status: number, reason: Refusal['reason'] = 'forbidden'): Refusal => ({
  ok: false,
  reason,
  message: code,
  code,
  status,
});
const failed = (code: string, status: number, reason: Refusal['reason'] = 'forbidden'): Resource<never> => ({
  status: 'failed',
  failure: refusal(code, status, reason),
});
const list = <T,>(items: T[], hasMore = false): ListState<T> => ({ status: 'ready', items, hasMore, more: 'idle' });
const noop = () => undefined;
/** Every page: no service code may reach the reader (B8). */
const expectPlain = (out: string) => expect(out).not.toMatch(/pay\.[a-z_]+/);

const fresh = { asOf: '2026-10-15T10:00:00.000Z', lagSeconds: 4 };
const snapshot = (patch: Partial<p.Snapshot> = {}): p.Snapshot => ({
  merchantId: 'm',
  freshness: fresh,
  balances: [{ assetCode: 'USDT', clearing: '10.5', available: '1234.560000000000000001' }],
  paymentCount: 12,
  statusMix: [
    { status: 'captured', count: 9 },
    { status: 'failed', count: 3 },
  ],
  captured: [{ assetCode: 'USDT', amount: '1500.25' }],
  refunded: [{ assetCode: 'USDT', amount: '20' }],
  net: [{ assetCode: 'USDT', amount: '1480.25' }],
  settlements: [],
  averagePayment: [{ assetCode: 'USDT', amount: '125.02' }],
  largestPayment: [{ assetCode: 'USDT', amount: '400' }],
  linkUsage: { linksUsed: 2, paymentsViaLinks: 5 },
  feeRevenue: [{ assetCode: 'USDT', amount: '15.0025' }],
  conversionVolume: null,
  ...patch,
});
const quiet = snapshot({
  paymentCount: 0,
  balances: [],
  statusMix: [],
  captured: [],
  refunded: [],
  net: [],
  averagePayment: [],
  largestPayment: [],
  feeRevenue: [],
  linkUsage: { linksUsed: 0, paymentsViaLinks: 0 },
});
const series: p.Series = {
  merchantId: 'm',
  freshness: fresh,
  points: [
    { day: '2026-10-14', assetCode: 'USDT', volume: '300', feeRevenue: '3' },
    { day: '2026-10-15', assetCode: 'USDT', volume: '1200.25', feeRevenue: '12.0025' },
  ],
};
const merchantRecord: p.MerchantRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  mode: 'gateway',
  status: 'active',
  kybStatus: 'approved',
  kybRef: 'ref-1',
  feeBps: 150,
};

describe('dashboard', () => {
  const data = (o: Partial<DashboardData> = {}): DashboardData => ({
    today: ready(snapshot()),
    rolling_7d: ready(snapshot()),
    rolling_30d: ready(snapshot()),
    series: ready(series),
    ...o,
  });
  const render = (d: DashboardData, m: p.MerchantRecord | null = merchantRecord) =>
    html(<DashboardView merchant={m} role="owner" data={d} retry={noop} todayDay="2026-10-15" />);

  it('shows loading skeletons while the numbers arrive', () => {
    const out = render(data({ today: loading, rolling_7d: loading, rolling_30d: loading, series: loading }));
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('Account status');
  });
  it('shows tiles per period with exact figures, per asset, and an as-of line', () => {
    const out = render(data());
    expect(out).toContain('Paid in');
    expect(out).toContain('1,500.25');
    expect(out).toContain('15.00');
    expect(out).toContain('USDT');
    expect(out).toContain('As of');
    expect(out).toContain('4 s behind');
    expect(out).toContain('1,234.56');
    expect(out).toMatch(/href="\/pay\/payments"/);
  });
  it('gives the chart a text equivalent and a table fallback control', () => {
    const out = render(data());
    expect(out).toMatch(/role="img" aria-label="Bar chart of daily volume in USDT/);
    expect(out).toContain('Show as a table');
    expect(out).toContain('aria-expanded="false"');
  });
  it('explains an empty new account instead of painting zeros', () => {
    const out = render(
      data({ today: ready(quiet), rolling_7d: ready(quiet), rolling_30d: ready(quiet), series: ready({ ...series, points: [] }) }),
    );
    expect(out).toContain('No payments yet');
    expect(out).toContain('Create a payment link');
    expect(out).not.toContain('Daily volume');
  });
  it('says plainly when numbers are stale or of unknown age', () => {
    const stale = render(data({ today: ready(snapshot({ freshness: { asOf: '2026-10-15T09:00:00.000Z', lagSeconds: 900 } })) }));
    expect(stale).toContain('older than expected');
    const unknown = render(data({ today: ready(snapshot({ freshness: { asOf: null, lagSeconds: null } })) }));
    expect(unknown).toContain('do not treat them as live');
  });
  it('shows "arrives soon" when the read model is not built, and a retry when it is merely unreachable', () => {
    const soon = render(
      data({ today: failed('pay.not_built', 501, 'not_supported'), rolling_30d: failed('pay.not_built', 501, 'not_supported') }),
    );
    expect(soon).toContain('Arrives soon');
    const down = render(data({ today: failed('', 503, 'unreachable') }));
    expect(down).toContain('Try again');
    expectPlain(down);
  });
  it('labels what is not built yet: tier, limits and operator pauses', () => {
    const out = render(data());
    expect(out).toContain('Limits, approvals and operator pauses');
    expect(out).toContain('Arrives soon');
  });
  it('points a not-yet-verified merchant at setup, and a team member sees their role not an account record', () => {
    expect(render(data(), { ...merchantRecord, status: 'pending', kybStatus: 'none' })).toContain('Continue setup');
    const member = render(data(), null);
    expect(member).toContain('Team member');
    expect(member).toContain('Owner');
  });
  it('shows a missing fee as not published, never a number', () => {
    expect(render(data(), { ...merchantRecord, feeBps: null })).toContain('Not published');
  });
});

describe('onboarding', () => {
  const base = {
    portal,
    kyb: ready<{ kybStatus: 'none' | 'pending' | 'approved' | 'rejected'; kybRef: string | null; mode: string } | null>(null),
    history: null,
    loadMoreHistory: noop,
    rails: ready([{ id: 'crypto-native', capabilities: ['payout'], mode: 'sandbox' as const, usable: true, healthy: true }]),
    saved: null,
    onCreated: noop,
    onKybSubmitted: noop,
    onDestinationSaved: noop,
    retry: noop,
  };
  it('starts at step 1 with grouped fields, required markers and the declared-volume label', () => {
    const out = html(<OnboardingView {...base} merchant={null} starterFeeBps={150} />);
    expect(out).toContain('Step 1 of 3');
    expect(out).toContain('Legal business name *');
    expect(out).toContain('Trading name');
    expect(out).not.toContain('Trading name *'); // optional
    expect(out).toContain('Leave it blank to use your legal name.');
    expect(out).toContain('Declared by you, not verified');
    expect(out).toContain('<legend>Your business</legend>');
    expect(out).toContain('Create my account');
    expectPlain(out);
  });
  it('refuses to open an account while no starting fee is published, and says why', () => {
    const out = html(<OnboardingView {...base} merchant={null} starterFeeBps={null} />);
    expect(out).toContain('Accounts cannot be opened yet');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Create my account<\/button>/);
  });
  it('moves to verification once the account exists, with the reference form and history', () => {
    const out = html(
      <OnboardingView
        {...base}
        merchant={{ ...merchantRecord, status: 'pending', kybStatus: 'none', kybRef: null }}
        kyb={ready({ kybStatus: 'none', kybRef: null, mode: 'gateway' })}
        history={list<p.KybEvent>([])}
        starterFeeBps={null}
      />,
    );
    expect(out).toContain('Verification file reference *');
    expect(out).toContain('Send for review');
    expect(out).toContain('Nothing sent yet');
    expect(out).toContain('never approved automatically');
  });
  it('shows a pending review without a form to resubmit', () => {
    const out = html(
      <OnboardingView
        {...base}
        merchant={{ ...merchantRecord, status: 'pending', kybStatus: 'pending' }}
        kyb={ready({ kybStatus: 'pending', kybRef: 'ref-9', mode: 'gateway' })}
        history={list<p.KybEvent>([
          {
            seq: '2',
            fromStatus: 'none',
            toStatus: 'pending',
            kybRef: 'ref-9',
            decidedBy: 'merchant',
            reason: null,
            at: '2026-10-15T09:00:00.000Z',
          },
        ])}
        starterFeeBps={null}
      />,
    );
    expect(out).toContain('INTAFACED is reviewing it');
    expect(out).not.toContain('Send for review');
    expect(out).toContain('Not sent to In review');
  });
  it('says there is no payout method when none is connected', () => {
    const out = html(
      <OnboardingView
        {...base}
        merchant={{ ...merchantRecord, kybStatus: 'approved' }}
        kyb={ready({ kybStatus: 'approved', kybRef: 'r', mode: 'gateway' })}
        rails={ready([])}
        starterFeeBps={null}
      />,
    );
    expect(out).toContain('No payout method is connected');
  });
  it('ends in a "live in sandbox" summary that keeps live waiting for approval', () => {
    const out = html(
      <OnboardingView
        {...base}
        merchant={{ ...merchantRecord, status: 'pending', kybStatus: 'pending' }}
        kyb={ready({ kybStatus: 'pending', kybRef: 'r', mode: 'gateway' })}
        history={list<p.KybEvent>([])}
        saved={{ railId: 'crypto-native', kind: 'crypto', ref: `0x${'a'.repeat(40)}` }}
        starterFeeBps={null}
      />,
    );
    expect(out).toContain('Destination saved for this visit');
    expect(out).not.toContain('You are live in sandbox');
    expect(out).toContain('Waiting for verification to be approved');
    expect(out).toContain('Your tier and limits arrive soon');
  });
});

describe('team and roles', () => {
  const member = (patch: Partial<p.Member>): p.Member => ({
    memberId: 'a1',
    userId: 'user-finance',
    role: 'finance',
    status: 'active',
    label: 'Accounts',
    invitedBy: 'owner-1',
    createdAt: '2026-10-01T00:00:00.000Z',
    activatedAt: '2026-10-02T00:00:00.000Z',
    removedAt: null,
    cursor: 'c1',
    ...patch,
  });
  const owner = member({ memberId: null, userId: 'owner-1', role: 'owner', label: null, invitedBy: null, cursor: null });
  const props = (role: p.MemberRole, extra: Partial<Parameters<typeof TeamView>[0]> = {}): Parameters<typeof TeamView>[0] => ({
    portal,
    me: ready({ merchantId: 'm', userId: 'owner-1', role }),
    invitations: ready<p.Invitation[]>([]),
    members: list([owner, member({})]),
    history: list<p.TeamEvent>([
      {
        seq: '3',
        memberUserId: 'user-finance',
        action: 'role_changed',
        fromRole: 'viewer',
        toRole: 'finance',
        actorId: 'owner-1',
        createdAt: '2026-10-03T00:00:00.000Z',
      },
    ]),
    status: '',
    setStatus: noop,
    loadMoreMembers: noop,
    loadMoreHistory: noop,
    refresh: noop,
    ...extra,
  });
  it('always says role changes need a verified (MFA) session', () => {
    expect(html(<TeamView {...props('owner')} />)).toContain('verified with two-step sign-in (MFA)');
  });
  it('lists members in an accessible table with row headers, roles and status words', () => {
    const out = html(<TeamView {...props('owner')} />);
    expect(out).toContain('role="region" aria-label="Members"');
    expect(out).toContain('<th scope="col">Role</th>');
    expect(out).toMatch(/<th scope="row">.*user-finance/);
    expect(out).toContain('Finance');
    expect(out).toContain('Active');
    expect(out).toContain('Change role');
    expect(out).toContain('Remove');
    expect(out).toContain('changed from Viewer to Finance');
  });
  it('locks the controls with a reason for someone who cannot manage the team', () => {
    const out = html(<TeamView {...props('viewer')} />);
    expect(out).not.toContain('>Change role<');
    expect(out).toContain('Only the owner or an admin can manage the team.');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Send invitation<\/button>/);
  });
  it('offers pending invitations to accept or decline', () => {
    const out = html(
      <TeamView
        {...props('viewer', {
          invitations: ready<p.Invitation[]>([
            { memberId: 'i1', merchantId: 'm', role: 'developer', invitedAt: '2026-10-14T00:00:00.000Z' },
          ]),
        })}
      />,
    );
    expect(out).toContain('Invitation to join a team as Developer');
    expect(out).toContain('>Accept<');
    expect(out).toContain('>Decline<');
  });
  it('has loading, empty, error and coming-soon states', () => {
    expect(html(<TeamView {...props('owner', { members: { status: 'loading' } })} />)).toContain('aria-busy="true"');
    expect(html(<TeamView {...props('owner', { members: list<p.Member>([]) })} />)).toContain('No members match');
    expect(
      html(
        <TeamView
          {...props('owner', {
            members: {
              status: 'failed',
              failure: refusal('pay.merchant_ops_unavailable', 503, 'unreachable'),
            },
          })}
        />,
      ),
    ).toContain('Try again');
    expect(
      html(
        <TeamView
          {...props('owner', {
            members: { status: 'failed', failure: refusal('pay.not_built', 501, 'not_supported') },
          })}
        />,
      ),
    ).toContain('Arrives soon');
  });
  it('says how many rows are shown and whether more exist', () => {
    expect(html(<TeamView {...props('owner', { members: list([owner, member({})], true) })} />)).toMatch(
      /2 shown so far\. More are available\./,
    );
    expect(html(<TeamView {...props('owner')} />)).toContain('2 shown. That is everything.');
  });
});

describe('disputes', () => {
  const dispute = (patch: Partial<p.Dispute> = {}): p.Dispute => ({
    disputeId: 'dsp-0001-aaaa-bbbb',
    paymentId: 'pay-0001-aaaa-bbbb',
    amount: '49.99',
    assetId: 'USDT',
    reasonCode: 'fraudulent',
    status: 'open',
    openedAt: '2026-10-10T00:00:00.000Z',
    contestedAt: null,
    closedAt: null,
    responseDueAt: null,
    ledgerWire: 'refused',
    ledgerRefuseCode: 'pay.chargeback_wire_absent',
    ...patch,
  });
  const sum = ready({
    total: 3,
    byStatus: { open: 1, contested: 1, accepted: 0, won: 1, lost: 0 },
    amountAtRisk: [{ assetId: 'USDT', amount: '99.98' }],
  });
  it('shows KPI tiles and a table with status words and links to each dispute', () => {
    const out = html(<DisputesView summary={sum} list={list([dispute()])} status="" setStatus={noop} loadMore={noop} retry={noop} />);
    expect(out).toContain('Needs a response');
    expect(out).toContain('99.98');
    expect(out).toContain('href="/pay/disputes/dsp-0001-aaaa-bbbb"');
    expect(out).toContain('The customer challenged this payment and you have not answered yet.');
    expect(out).toContain('No deadline');
    expect(out).toContain('No deadline has been published');
    expectPlain(out);
  });
  it('explains an empty list and a filter with no match', () => {
    const empty = html(<DisputesView summary={sum} list={list<p.Dispute>([])} status="" setStatus={noop} loadMore={noop} retry={noop} />);
    expect(empty).toContain('A dispute is a payment a customer has challenged');
    const none = html(
      <DisputesView summary={sum} list={list<p.Dispute>([])} status="lost" setStatus={noop} loadMore={noop} retry={noop} />,
    );
    expect(none).toContain('No disputes with that status');
  });
  it('falls back to a coming-soon notice with a way to the older list while the service is off', () => {
    const off = failed('pay.not_built', 501, 'not_supported');
    const offFailure = refusal('pay.not_built', 501, 'not_supported');
    const out = html(
      <DisputesView
        summary={off}
        list={{ status: 'failed', failure: offFailure }}
        status=""
        setStatus={noop}
        loadMore={noop}
        retry={noop}
      />,
    );
    expect(out).toContain('Arrives soon');
    expect(out).toContain('href="/pay/disputes?view=payments"');
  });
  const detail = (patch: Partial<p.DisputeDetail> = {}): p.DisputeDetail => ({
    ...dispute(),
    canRespond: true,
    evidence: [
      {
        evidenceId: 'e1',
        kind: 'receipt',
        fileName: 'receipt.pdf',
        contentType: 'application/pdf',
        sizeBytes: '2048',
        sha256: 'a'.repeat(64),
        note: null,
        addedBy: 'owner-1',
        createdAt: '2026-10-11T00:00:00.000Z',
      },
    ],
    responses: [],
    payment: {
      paymentId: 'pay-0001-aaaa-bbbb',
      status: 'disputed',
      assetId: 'USDT',
      amount: '49.99',
      createdAt: '2026-10-01T00:00:00.000Z',
    },
    ...patch,
  });
  it('shows a detail page with key facts, timeline, evidence metadata and the two ways to respond', () => {
    const out = html(<DisputeDetailView portal={portal} dispute={ready(detail())} reload={noop} />);
    expect(out).toContain('Key facts');
    expect(out).toContain('Timeline');
    expect(out).toContain('Dispute opened');
    expect(out).toContain('Evidence added: Receipt');
    expect(out).toContain('receipt.pdf');
    expect(out).toContain('2.0 KB');
    expect(out).toContain('Only the file’s name, type, size and a fingerprint');
    expect(out).toContain('Contest the dispute');
    expect(out).toContain('Accept liability');
    expect(out).toContain('Not recorded yet');
    expectPlain(out);
  });
  it('blocks contesting until there is evidence, and says why', () => {
    const out = html(<DisputeDetailView portal={portal} dispute={ready(detail({ evidence: [] }))} reload={noop} />);
    expect(out).toContain('No evidence yet');
    expect(out).toContain('Add at least one piece of evidence to contest.');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Contest the dispute<\/button>/);
  });
  it('shows a closed dispute without response controls', () => {
    const out = html(
      <DisputeDetailView
        portal={portal}
        dispute={ready(detail({ status: 'lost', canRespond: false, closedAt: '2026-10-12T00:00:00.000Z' }))}
        reload={noop}
      />,
    );
    expect(out).toContain('This dispute is closed. No response is needed.');
    expect(out).toContain('Closed: Lost');
    expect(out).not.toContain('>Contest the dispute<');
    expect(out).toContain('This dispute is closed, so evidence can no longer be added.');
  });
  it('answers an unknown dispute in plain words', () => {
    const out = html(<DisputeDetailView portal={portal} dispute={failed('pay.dispute_not_found', 404, 'not_mounted')} reload={noop} />);
    expect(out).toContain('We could not find that dispute.');
    expectPlain(out);
  });
});

describe('customers', () => {
  const customer = (patch: Partial<p.Customer> = {}): p.Customer => ({
    customerRef: 'cust-42',
    paymentCount: 3,
    subscriptionCount: 1,
    mandateCount: 0,
    firstSeenAt: '2026-09-01T00:00:00.000Z',
    lastSeenAt: '2026-10-14T00:00:00.000Z',
    totals: [{ assetId: 'USDT', capturedAmount: '300.5', refundedAmount: '0', paymentCount: 3 }],
    ...patch,
  });
  const sum = ready({ customerCount: 10, activeSinceCount: 4, repeatCustomerCount: 3, activeSince: '2026-09-15T00:00:00.000Z' });
  const render = (l: ListState<p.Customer>, search = '') =>
    html(<CustomersView summary={sum} list={l} search={search} setSearch={noop} loadMore={noop} retry={noop} />);
  it('shows a directory with search, lifetime totals and a link per customer', () => {
    const out = render(list([customer()]));
    expect(out).toContain('role="search"');
    expect(out).toContain('href="/pay/customers/cust-42"');
    expect(out).toContain('300.5');
    expect(out).toContain('30%');
    expect(out).toContain('We store only the reference you supply');
  });
  it('encodes an awkward reference in its link', () => {
    expect(render(list([customer({ customerRef: 'a/b c' })]))).toContain('href="/pay/customers/a%2Fb%20c"');
  });
  it('has empty and no-match states that say what to do', () => {
    expect(render(list<p.Customer>([]))).toContain('No customers yet');
    expect(render(list<p.Customer>([]), 'zzz')).toContain('No reference starts with “zzz”.');
  });
  it('shows loading and a plain failure', () => {
    expect(render({ status: 'loading' })).toContain('aria-busy="true"');
    const out = html(
      <CustomersView
        summary={failed('', 503, 'unreachable')}
        list={{ status: 'failed', failure: refusal('', 503, 'unreachable') }}
        search=""
        setSearch={noop}
        loadMore={noop}
        retry={noop}
      />,
    );
    expect(out).toContain('Try again');
  });
  it('shows a detail page with lifetime tiles and recent payments', () => {
    const detail: p.CustomerDetail = {
      ...customer(),
      recentPayments: [
        {
          paymentId: '99999999-aaaa-bbbb-cccc-dddddddddddd',
          status: 'captured',
          assetId: 'USDT',
          amount: '100',
          createdAt: '2026-10-14T00:00:00.000Z',
        },
      ],
    };
    const out = html(<CustomerDetailView customer={ready(detail)} reload={noop} />);
    expect(out).toContain('Lifetime totals');
    expect(out).toContain('300.5');
    expect(out).toContain('Recent payments');
    expect(out).toContain('Paid');
    expect(out).toContain('Daily charts for a single customer are not available yet.');
  });
});

describe('exports', () => {
  const job = (patch: Partial<p.ExportJob> = {}): p.ExportJob => ({
    jobId: 'j1',
    kind: 'payments',
    filters: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z', status: 'captured' },
    status: 'ready',
    failureCode: null,
    fileName: 'payments.csv',
    sizeBytes: '1024',
    rowCount: 42,
    sha256: 'a'.repeat(64),
    requestedBy: 'owner-1',
    asOf: '2026-10-15T09:00:00.000Z',
    expiresAt: null,
    createdAt: '2026-10-15T09:00:00.000Z',
    completedAt: '2026-10-15T09:00:05.000Z',
    ...patch,
  });
  const render = (l: ListState<p.ExportJob>) =>
    html(<ExportsView portal={portal} list={l} kind="" setKind={noop} status="" setStatus={noop} loadMore={noop} reload={noop} />);
  it('offers the three report kinds with what each contains', () => {
    const out = render(list([job()]));
    for (const word of ['Payments', 'Settlements', 'Payouts', 'Request export']) expect(out).toContain(word);
    expect(out).toContain('It includes only your data');
  });
  it('lists jobs with status words, range, rows, and a download only for a ready one', () => {
    const out = render(
      list([
        job(),
        job({ jobId: 'j2', status: 'running', rowCount: null, fileName: null }),
        job({ jobId: 'j3', status: 'failed', rowCount: null, fileName: null }),
      ]),
    );
    expect(out).toContain('Ready');
    expect(out).toContain('Building');
    expect(out).toContain('Failed');
    expect(out).toContain('It could not be built. Try a narrower date range.');
    expect(out.match(/>Download</g)?.length).toBe(1);
    expect(out).toContain('2026-10-01 to 2026-10-08');
    expect(out).toContain('Does not expire');
  });
  it('has empty, loading, error and coming-soon states', () => {
    expect(render(list<p.ExportJob>([]))).toContain('No exports yet');
    expect(render({ status: 'loading' })).toContain('aria-busy="true"');
    expect(render({ status: 'failed', failure: refusal('pay.not_built', 501, 'not_supported') })).toContain('Arrives soon');
    expect(render({ status: 'failed', failure: refusal('pay.merchant_ops_unavailable', 503, 'unreachable') })).toContain('Try again');
  });
});

describe('notifications', () => {
  const note = (patch: Partial<p.Notification> = {}): p.Notification => ({
    notificationId: 'n1',
    kind: 'dispute_opened',
    title: 'A customer challenged a payment',
    body: 'Payment pay-0001',
    subjectType: 'dispute',
    subjectId: 'dsp-1',
    createdAt: '2026-10-15T08:00:00.000Z',
    readAt: null,
    ...patch,
  });
  const prefs = ready<p.Preference[]>(
    p.notificationKinds.map((kind) => ({
      kind,
      inApp: kind !== 'team_change',
      threshold: kind === 'limit_threshold' ? '500.5' : null,
      updatedAt: null,
    })),
  );
  const render = (view: 'feed' | 'preferences', feed: ListState<p.Notification>) =>
    html(
      <NotificationsView
        portal={portal}
        view={view}
        setView={noop}
        feed={feed}
        kind=""
        setKind={noop}
        unreadOnly={false}
        setUnreadOnly={noop}
        prefs={prefs}
        loadMore={noop}
        reload={noop}
        reloadPrefs={noop}
      />,
    );
  it('shows a feed with unread marked in words and a link to the subject', () => {
    const out = render(
      'feed',
      list([
        note(),
        note({
          notificationId: 'n2',
          readAt: '2026-10-15T09:00:00.000Z',
          title: 'Export ready',
          kind: 'export_ready',
          subjectType: 'export',
        }),
      ]),
    );
    expect(out).toContain('A customer challenged a payment');
    expect(out).toMatch(/pp-sr">[^<]*<!-- -->unread/);
    expect(out).toContain('href="/pay/disputes/dsp-1"');
    expect(out).toContain('Mark read');
    expect(out).toContain('Mark all read');
  });
  it('has empty, loading and error states', () => {
    expect(render('feed', list<p.Notification>([]))).toContain('Nothing yet');
    expect(render('feed', { status: 'loading' })).toContain('aria-busy="true"');
    expect(render('feed', { status: 'failed', failure: refusal('', 503, 'unreachable') })).toContain('Try again');
  });
  it('lists every kind in preferences, says it is in-app only, and takes a threshold with no default', () => {
    const out = render('preferences', list<p.Notification>([]));
    for (const label of [
      'Payout waiting for approval',
      'Settlement failed',
      'Dispute response due',
      'Webhook failing',
      'INTAFACED paused something',
      'Team change',
    ])
      expect(out).toContain(label);
    expect(out).toContain('Nothing is sent by email or text');
    expect(out).toContain('Alert when a limit reaches');
    expect(out).toContain('value="500.5"');
    expect(out).toContain('There is no default');
    expect((out.match(/type="checkbox"/g) ?? []).length).toBe(p.notificationKinds.length);
  });
});
