import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
// Server rendering has no external store snapshot for the language preference; read it directly.
vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import type { ReactElement } from 'react';
import type { ApiResult } from '../../../../shared/api';
import type { Resource } from '../../../../shared/resource';
import type { PortalApi } from '../api';
import { CustomerDetailView, CustomersView } from './Customers';
import { DashboardInsights as DashboardView, type DashboardData } from './Dashboard';
import { DisputeDetailView, DisputesView } from './Disputes';
import { useListFilters } from '../ui/FilterRow';
import { seriesTotals } from './model';
import { countdown, fileProblem, fromBase64, toBase64 } from './dispute-model';
import type { ListState } from '../hooks';
import * as p from '../schemas';
import { notLiveWords } from '../ui/test-words';
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
    expect(soon).toMatch(notLiveWords);
    const down = render(data({ today: failed('', 503, 'unreachable') }));
    expect(down).toContain('Try again');
    expectPlain(down);
  });
  it('labels what is not built yet: tier, limits and operator pauses', () => {
    const out = render(data());
    expect(out).toContain('Limits and approvals');
    expect(out).toMatch(notLiveWords);
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
  function Harness(props: { summary: Resource<never> | typeof sum; list: ListState<p.Dispute>; due?: string }) {
    const filters = useListFilters();
    return (
      <DisputesView
        summary={props.summary as never}
        list={props.list}
        filters={filters}
        due={props.due ?? ''}
        setDue={noop}
        loadMore={noop}
        retry={noop}
      />
    );
  }
  it('shows tiles that each open their own filtered list, and rows with a countdown and a link to the payment', () => {
    const soon = dispute({ responseDueAt: new Date(Date.now() + 2 * 86_400_000 + 3_600_000).toISOString() });
    const out = html(<Harness summary={sum} list={list([dispute({ disputeId: 'dsp-0002-aaaa-bbbb' }), soon])} />);
    expect(out).toContain('Needs a response');
    expect(out).toContain('99.98');
    expect(out).toContain('href="/pay/disputes?status=open"');
    expect(out).toContain('href="/pay/disputes/dsp-0001-aaaa-bbbb"');
    expect(out).toContain('href="/pay/payments/pay-0001-aaaa-bbbb"');
    expect(out).toContain('Due in 2 d');
    expect(out).toContain('No deadline');
    expect(out).toContain('Fraud');
    expect(out).not.toContain('fraudulent');
    expect(out.indexOf('Due in 2 d')).toBeLessThan(out.indexOf('No deadline'));
    expectPlain(out);
  });
  it('counts the deadline down in plain words and never invents one', () => {
    const now = Date.parse('2026-10-17T12:00:00Z');
    const due = (iso: string | null, status: p.Dispute['status'] = 'open') => countdown({ status, responseDueAt: iso }, now);
    expect(due(null)).toEqual({ kind: 'none' });
    expect(due('2026-10-16T12:00:00Z')).toEqual({ kind: 'overdue', days: 1 });
    expect(due('2026-10-17T20:00:00Z')).toEqual({ kind: 'today' });
    expect(due('2026-10-19T12:00:00Z')).toEqual({ kind: 'soon', days: 2 });
    expect(due('2026-10-30T12:00:00Z')).toEqual({ kind: 'later', days: 13 });
    expect(due('2026-10-30T12:00:00Z', 'won')).toEqual({ kind: 'closed' });
  });
  it('checks an evidence file before it is sent', () => {
    expect(fileProblem({ contentType: 'application/pdf', sizeBytes: 1000 })).toBeNull();
    expect(fileProblem({ contentType: 'application/zip', sizeBytes: 1000 })).toBe('type');
    expect(fileProblem({ contentType: 'image/png', sizeBytes: 2_000_000 })).toBe('size');
    expect(fileProblem({ contentType: 'image/png', sizeBytes: 0 })).toBe('empty');
    expect(fromBase64(toBase64(new Uint8Array([1, 2, 250, 255])))).toEqual(new Uint8Array([1, 2, 250, 255]));
  });
  it('explains an empty list and a filter with no match', () => {
    const empty = html(<Harness summary={sum} list={list<p.Dispute>([])} />);
    expect(empty).toContain('A dispute is a payment a customer has challenged');
    const none = html(<Harness summary={sum} list={list<p.Dispute>([])} due="3d" />);
    expect(none).toContain('No disputes match these filters');
  });
  it('shows the not-live notice while the service is off', () => {
    const off = failed('pay.not_built', 501, 'not_supported');
    const offFailure = refusal('pay.not_built', 501, 'not_supported');
    const out = html(<Harness summary={off} list={{ status: 'failed', failure: offFailure }} />);
    expect(out).toMatch(notLiveWords);
    expect(out).not.toContain('view=payments');
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
    expect(out).toContain('The file is stored with this dispute');
    expect(out).toContain('Download');
    expect(out).toContain('href="/pay/payments/pay-0001-aaaa-bbbb"');
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
    const series = ready({
      customerRef: 'TEST-cust-001',
      bucket: 'day',
      from: '2026-09-18',
      to: '2026-10-18',
      items: [
        { period: '2026-10-17', assetCode: 'USDT', count: 2, volume: '50.25' },
        { period: '2026-10-12', assetCode: 'USDT', count: 1, volume: '10' },
        { period: '2026-09-25', assetCode: 'USDT', count: 1, volume: '7.5' },
      ],
      nextCursor: null,
    });
    const out = html(<CustomerDetailView customer={ready(detail)} series={series} today="2026-10-17" reload={noop} />);
    expect(out).toContain('Lifetime totals');
    expect(out).toContain('300.5');
    expect(out).toContain('Recent payments');
    expect(out).toContain('Paid');
    expect(out).toContain('Daily volume and payment count');
    expect(out).toContain('60.25');
    expect(out).toContain('67.75');
    expect(out).toContain('href="/pay/payments/99999999-aaaa-bbbb-cccc-dddddddddddd"');
  });
  it('sums a customer series per asset from a day, exactly', () => {
    const items = [
      { period: '2026-10-17', assetCode: 'USDT', count: 2, volume: '0.1' },
      { period: '2026-10-16', assetCode: 'USDT', count: 1, volume: '0.2' },
      { period: '2026-10-16', assetCode: 'USD', count: 1, volume: '5' },
      { period: '2026-10-01', assetCode: 'USDT', count: 9, volume: '100' },
    ];
    expect(seriesTotals(items, '2026-10-16')).toEqual([
      { assetCode: 'USD', count: 1, volume: '5' },
      { assetCode: 'USDT', count: 3, volume: '0.3' },
    ]);
  });
});
