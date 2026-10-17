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
import { PaymentDetailView, PaymentsView } from './Payments';
import { portalRefusal } from '../refusal';
import * as p from '../schemas';
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
const down = failed('', 503, 'unreachable');
const soon = failed('pay.not_built', 501, 'not_supported');
const forbidden = failed('pay.merchant_forbidden', 403);
const noop = () => undefined;
/** Every page: no service code may reach the reader (B8). */
const expectPlain = (out: string) => expect(out).not.toMatch(/pay\.[a-z_]+/);
const fresh = { asOf: '2026-10-15T11:59:56.000Z', lagSeconds: 4 };
const quietHalts = ready<p.HaltStatus>({ readable: true, states: [] });
const snapshot = (patch: Partial<p.Snapshot> = {}): p.Snapshot => ({
  merchantId: 'm',
  freshness: fresh,
  balances: [],
  paymentCount: 12,
  statusMix: [
    { status: 'captured', count: 9 },
    { status: 'failed', count: 3 },
  ],
  captured: [{ assetCode: 'USDT', amount: '1500.25' }],
  refunded: [{ assetCode: 'USDT', amount: '20' }],
  net: [],
  settlements: [{ assetCode: 'USDT', gross: '2400.5', fees: '36', net: '2364.5' }],
  averagePayment: [],
  largestPayment: [],
  linkUsage: { linksUsed: 0, paymentsViaLinks: 0 },
  feeRevenue: [],
  conversionVolume: null,
  ...patch,
});
const payment = (patch: Partial<p.Payment> = {}): p.Payment => ({
  id: 'aa000001-0000-4000-8000-000000000001',
  merchantId: '11111111-1111-4111-8111-111111111111',
  profileId: null,
  amount: '125.5',
  assetId: 'USDT',
  method: 'TEST-method',
  railAdapter: 'crypto-native',
  railRef: 'TEST-rail-0001',
  status: 'captured',
  capturedAmount: '125.5',
  refundedAmount: '20',
  createdAt: '2026-10-14T09:00:00.000Z',
  ...patch,
});
const settlement = (patch: Partial<p.Settlement> = {}): p.Settlement => ({
  id: 'bb000001-0000-4000-8000-000000000001',
  merchantId: '11111111-1111-4111-8111-111111111111',
  window: 'TEST-2026-W41',
  assetId: 'USDT',
  gross: '1000',
  fees: '15',
  net: '985',
  payoutMethod: null,
  payoutRef: null,
  status: 'posted',
  ...patch,
});
describe('payments list (P06)', () => {
  const view = (patch: Partial<Parameters<typeof PaymentsView>[0]> = {}) =>
    html(
      <PaymentsView
        snapshot={ready(snapshot())}
        period="rolling_30d"
        setPeriod={noop}
        halts={quietHalts}
        list={ready([
          payment(),
          payment({ id: 'aa000002-0000-4000-8000-000000000002', status: 'failed', capturedAmount: '0', refundedAmount: '0' }),
        ])}
        loadedAt="2026-10-15T12:00:00.000Z"
        status=""
        setStatus={noop}
        filters={{ q: '', asset: '', from: '', to: '' }}
        setFilter={noop}
        sort="newest"
        setSort={noop}
        limit={25}
        setLimit={noop}
        retry={noop}
        {...patch}
      />,
    );
  it('shows a KPI strip with its period and as-of line, then a table with links, status words and exact amounts', () => {
    const out = view();
    expect(out).toContain('Totals for Last 30 days');
    expect(out).toContain('As of');
    expect(out).toContain('4 s behind');
    expect(out).toContain('Success rate');
    expect(out).toContain('75%');
    expect(out).toContain('3 failed out of 12');
    expect(out).toContain('href="/pay/payments?status=failed"');
    expect(out).toContain('href="/pay/payments/aa000001-0000-4000-8000-000000000001"');
    expect(out).toContain('125.5');
    expect(out).toContain('Paid');
    expect(out).toContain('Failed');
    expect(out).toContain('Download CSV');
    expect(out).toContain('2 shown. That is everything.');
    expectPlain(out);
  });
  it('keeps filters in view: status, asset, dates, search, sort and a note on what search covers', () => {
    const out = view();
    for (const label of ['Status', 'Asset', 'From (UTC day)', 'To (UTC day)', 'Search', 'Sort by']) expect(out).toContain(label);
    expect(out).toContain('Looks through the payments shown below');
  });
  it('says there is more to load while the page is full, and points at exports once the cap is reached', () => {
    expect(view({ limit: 2 })).toContain('2 shown so far. More are available.');
    const many = Array.from({ length: 200 }, (_, i) => payment({ id: `aa${String(i).padStart(6, '0')}-0000-4000-8000-000000000000` }));
    const out = view({ list: ready(many), limit: 200 });
    expect(out).toContain('Showing the newest 200. For older records, request an export.');
  });
  it('explains an empty account, an empty status and a filter that matches nothing', () => {
    expect(view({ list: ready<p.Payment[]>([]) })).toContain('No payments yet');
    expect(view({ list: ready<p.Payment[]>([]), status: 'failed' })).toContain('No payments with that status');
    const none = view({ filters: { q: 'zzz', asset: '', from: '', to: '' } });
    expect(none).toContain('No payment shown matches');
    expect(none).toContain('Clear filters');
  });
  it('shows loading, an unreachable service with a retry, a refusal in plain words, and arrives-soon', () => {
    expect(view({ list: loading, snapshot: loading })).toContain('aria-busy="true"');
    const unreachable = view({ list: down, snapshot: down });
    expect(unreachable).toContain('Try again');
    expectPlain(unreachable);
    const refused = view({ list: forbidden, snapshot: forbidden });
    expect(refused).toContain('Your account does not have access to this.');
    expectPlain(refused);
    expect(view({ snapshot: soon })).toContain('Coming soon');
  });
  it('says it could not check when the pause read fails, is refused, or is unavailable, and never reads that as "nothing paused"', () => {
    for (const halts of [down, forbidden, soon, failed('pay.merchant_ops_unavailable', 503, 'unreachable')]) {
      const out = view({ halts });
      expect(out).toContain('We could not check whether new payments are paused.');
      expectPlain(out);
    }
    expect(view({ halts: loading })).not.toContain('could not check');
    expect(view()).not.toContain('could not check');
  });
  it('names a paused operation in a banner, and treats an unreadable pause store as paused', () => {
    const paused = view({
      halts: ready<p.HaltStatus>({
        readable: true,
        states: [{ scope: 'intake', target: { level: 'global' }, halted: true, changedAt: '2026-10-15T08:00:00.000Z' }],
      }),
    });
    expect(paused).toContain('New payments are paused.');
    expect(paused).toContain('INTAFACED has paused this for every account');
    expect(view({ halts: ready<p.HaltStatus>({ readable: false, states: [] }) })).toContain(
      'treat payments, settlements and payouts as paused',
    );
  });
});
describe('payment detail (P07)', () => {
  const ev = (event: string, payload: Record<string, unknown>, ts: string): p.PaymentEvent => ({
    id: 'ee000001-0000-4000-8000-000000000001',
    event,
    payload,
    railEventId: null,
    ts,
  });
  const events = [
    ev(
      'created',
      { amount: '125.5', customerRef: 'TEST-cust-001', instrument: { kind: 'token', token: 'tok_TEST_must_never_show' } },
      '2026-10-14T09:00:00.000Z',
    ),
    ev('rail.authorize', { raw: 'rail internals' }, '2026-10-14T09:00:30.000Z'),
    ev('captured', { amount: '125.5', ledgerTxId: 'TEST-ledger-tx-1' }, '2026-10-14T09:01:00.000Z'),
    ev('refund.posted', { refundId: 'TEST-refund-1', amount: '20' }, '2026-10-14T10:00:00.000Z'),
    ev('refunded', { refundId: 'TEST-refund-1', amount: '20' }, '2026-10-14T10:00:01.000Z'),
    ev('settled', { settlementId: 'bb000002-0000-4000-8000-000000000002' }, '2026-10-14T12:00:00.000Z'),
  ];
  const view = (patch: Partial<Parameters<typeof PaymentDetailView>[0]> = {}) =>
    html(<PaymentDetailView payment={ready(payment())} history={ready(events)} dispute={null} retry={noop} {...patch} />);
  it('shows key facts, amounts, a plain timeline, refunds, related links and copyable ids', () => {
    const out = view();
    expect(out).toContain('Key facts');
    expect(out).toContain('TEST-rail-0001');
    expect(out).toContain('TEST-cust-001');
    expect(out).toContain('Still refundable');
    expect(out).toContain('105.5');
    expect(out).toContain('Payment created');
    expect(out).toContain('Money taken');
    expect(out).toContain('Added to a settlement');
    expect(out).toContain('Refunds');
    expect(out).toContain('Completed');
    expect(out).toContain('href="/pay/settlements/bb000002-0000-4000-8000-000000000002"');
    expect(out).toContain('TEST-ledger-tx-1');
    expect(out).toContain('pp-copy');
    expectPlain(out);
  });
  it('never prints the payer’s instrument or a rail’s internals', () => {
    const out = view();
    expect(out).not.toContain('tok_TEST_must_never_show');
    expect(out).not.toContain('rail internals');
  });
  it('says what is not built: fee, net and the pricing rule that applied', () => {
    const out = view();
    expect(out).toContain('Fee, net and the price that applied');
    expect(out).toContain('Coming soon');
    expect(out).toContain('href="/pay/pricing"');
  });
  it('shows a dispute card with a link, and says when a disputed payment has no linked dispute', () => {
    const dispute: p.DisputeDetail = {
      disputeId: 'd0000001-0000-4000-8000-000000000001',
      paymentId: 'aa000001-0000-4000-8000-000000000001',
      amount: '125.5',
      assetId: 'USDT',
      reasonCode: 'fraudulent',
      status: 'open',
      openedAt: '2026-10-14T00:00:00.000Z',
      contestedAt: null,
      closedAt: null,
      responseDueAt: null,
      ledgerWire: 'refused',
      ledgerRefuseCode: null,
      canRespond: true,
      evidence: [],
      responses: [],
      payment: null,
    };
    const out = view({ payment: ready(payment({ status: 'disputed' })), dispute: ready<p.DisputeDetail | null>(dispute) });
    expect(out).toContain('href="/pay/disputes/d0000001-0000-4000-8000-000000000001"');
    expect(out).toContain('fraudulent');
    expect(view()).toContain('The customer has not disputed this payment.');
    expect(view({ payment: ready(payment({ status: 'disputed' })) })).toContain('no dispute record could be linked');
  });
  it('shows loading, a not-found refusal that does not say whose payment it is, and an unreachable service', () => {
    expect(view({ payment: loading })).toContain('aria-busy="true"');
    const missing = html(
      <PaymentDetailView
        payment={{ status: 'failed', failure: portalRefusal('rPaymentNotFound') }}
        history={loading}
        dispute={null}
        retry={noop}
      />,
    );
    expect(missing).toContain('We could not find that payment.');
    expect(view({ payment: down })).toContain('Try again');
    expect(view({ history: down })).toContain('Try again');
    expectPlain(view({ payment: forbidden }));
  });
});
