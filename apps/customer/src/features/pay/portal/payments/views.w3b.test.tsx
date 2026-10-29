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
import { useListFilters } from '../ui/FilterRow';
import { canRefund, feeSummary, percentOf, totalsPeriod } from './payment-model';
import type { ListState } from '../hooks';
import type { PortalApi } from '../api';
import { portalRefusal } from '../refusal';
import * as p from '../schemas';
import { notLiveWords } from '../ui/test-words';
import { withMoneyAccess } from '../access/money-test-kit';
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
const portal = {} as PortalApi;
const listOf = (items: p.Payment[], hasMore = false): ListState<p.Payment> => ({ status: 'ready', items, hasMore, more: 'idle' });
function ListHarness({
  list,
  snapshot: snap,
  halts,
}: {
  list: ListState<p.Payment>;
  snapshot: Resource<p.Snapshot>;
  halts: Resource<p.HaltStatus>;
}) {
  const filters = useListFilters();
  return (
    <PaymentsView portal={portal} filters={filters} range={{}} list={list} snapshot={snap} halts={halts} loadMore={noop} retry={noop} />
  );
}
describe('payments list (P06)', () => {
  const view = (patch: Partial<Parameters<typeof ListHarness>[0]> = {}) =>
    html(
      <ListHarness
        list={listOf([
          payment(),
          payment({ id: 'aa000002-0000-4000-8000-000000000002', status: 'failed', capturedAmount: '0', refundedAmount: '0' }),
        ])}
        snapshot={ready(snapshot())}
        halts={quietHalts}
        {...patch}
      />,
    );
  it('shows tiles that each name their period and open the list with the same filter, then rows that open the payment', () => {
    const out = view();
    expect(out).toContain('Last 30 days');
    expect(out).toContain('href="/pay/payments?status=failed&amp;date=30d"');
    expect(out).toContain('href="/pay/payments?date=30d"');
    expect(out).toContain('href="/pay/refunds?from=');
    expect(out).toContain('href="/pay/payments/aa000001-0000-4000-8000-000000000001"');
    expect(out).toContain('Success rate');
    expect(out).toContain('75%');
    expect(out).toContain('3 failed out of 12');
    expect(out).toContain('Paid');
    expect(out).toContain('Failed');
    expect(out).toContain('Export these results');
    expect(out).toContain('2 shown');
    expectPlain(out);
  });
  it('picks the totals period from the date filter, and says when the list is wider than the totals', () => {
    expect(totalsPeriod('7d')).toEqual({ period: '7d', matchesList: true });
    expect(totalsPeriod('')).toEqual({ period: '30d', matchesList: false });
    expect(totalsPeriod('custom')).toEqual({ period: '30d', matchesList: false });
    expect(view()).toContain('These totals cover Last 30 days. The list below isn’t limited to that period.');
  });
  it('keeps filters in view: search, status, date and asset', () => {
    const out = view();
    for (const label of ['Search', 'Status', 'Date']) expect(out).toContain(label);
  });
  it('offers Load more only while another page exists', () => {
    expect(view()).not.toContain('Load more</button>');
    expect(view({ list: listOf([payment()], true) })).toContain('Load more');
  });
  it('explains an empty account', () => {
    const out = view({ list: listOf([]) });
    expect(out).toContain('Your first payment starts here');
    expect(out).toContain('href="/pay/links/new"');
  });
  it('shows loading, an unreachable service with a retry, a refusal in plain words, and the not-live card', () => {
    expect(view({ list: { status: 'loading' }, snapshot: loading })).toContain('aria-busy="true"');
    const unreachable = view({ list: { status: 'failed', failure: refusal('', 503, 'unreachable') }, snapshot: down });
    expect(unreachable).toContain('Try again');
    expectPlain(unreachable);
    const refused = view({ list: { status: 'failed', failure: refusal('pay.merchant_forbidden', 403) }, snapshot: forbidden });
    expect(refused).toContain('Your account does not have access to this.');
    expectPlain(refused);
    expect(view({ snapshot: soon })).toMatch(notLiveWords);
  });
  it('says it could not check when the pause read fails, and never reads that as "nothing paused"', () => {
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
    expect(view({ halts: ready<p.HaltStatus>({ readable: false, states: [] }) })).toContain(
      'treat payments, settlements and payouts as paused',
    );
  });
});
describe('payment summary rules', () => {
  const snap = (patch = {}) => ({
    fee: '1.20',
    assetCode: 'USDT',
    appliedLayer: 'tier' as const,
    ruleId: 'r',
    feeBps: 150,
    flatFee: '0.30',
    spreadBps: null,
    roundingBeneficiary: 'platform' as const,
    roundingMode: 'ceil' as const,
    bookedFee: null,
    reserveAmount: null,
    recordedAt: '2026-10-14T09:00:00.000Z',
    ...patch,
  });
  it('reads the stored fee and never recomputes one', () => {
    const base = { assetId: 'USDT', capturedAmount: '125.5' };
    expect(feeSummary({ ...base, pricingSnapshot: null })).toEqual({ kind: 'none' });
    expect(feeSummary({ ...base })).toEqual({ kind: 'none' });
    expect(feeSummary({ ...base, pricingSnapshot: { fee: '2' } })).toEqual({ kind: 'fee', fee: '2', net: '123.5', assetId: 'USDT' });
    const full = feeSummary({ ...base, pricingSnapshot: snap() });
    expect(full).toMatchObject({ kind: 'rule', fee: '1.20', net: '124.3', layer: 'tier', percent: '1.5', flatFee: '0.30' });
  });
  it('shows no net for an uncaptured payment', () => {
    expect(feeSummary({ assetId: 'USDT', capturedAmount: '0', pricingSnapshot: { fee: '2' } })).toMatchObject({ kind: 'fee', net: null });
  });
  it('writes basis points as an exact percentage', () => {
    expect([percentOf(150), percentOf(100), percentOf(5), percentOf(250), percentOf(0)]).toEqual(['1.5', '1', '0.05', '2.5', '0']);
  });
  it('offers Refund only when something captured is still unrefunded', () => {
    expect(canRefund({ status: 'captured', capturedAmount: '10', refundedAmount: '4' })).toBe(true);
    expect(canRefund({ status: 'refunded', capturedAmount: '10', refundedAmount: '10' })).toBe(false);
    expect(canRefund({ status: 'failed', capturedAmount: '0', refundedAmount: '0' })).toBe(false);
    expect(canRefund({ status: 'authorized', capturedAmount: '0', refundedAmount: '0' })).toBe(false);
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
  const view = (patch: Partial<Parameters<typeof PaymentDetailView>[0]> = {}, held = true) =>
    html(
      withMoneyAccess(
        <PaymentDetailView
          payment={ready(payment())}
          history={ready(events)}
          refunds={down}
          activity={[]}
          dispute={null}
          retry={noop}
          {...patch}
        />,
        held,
      ),
    );
  it('switches Refund off, with the reason, when the person cannot begin a refund', () => {
    const out = view({}, false);
    expect(out).toContain('Only the account owner can refund payments.');
    expect(out).not.toContain('href="/pay/refunds/new');
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Refund/);
  });
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
    expect(out).toContain('Copy');
    expectPlain(out);
  });
  it('counts confirmations while an open payment waits for them, with their as-of, and not once it has moved on (J-merchant-05 #4)', () => {
    const confirmations = { seen: 2, required: 6, asOf: '2026-10-14T09:00:40.000Z' };
    const waiting = view({ payment: ready(payment({ status: 'created', confirmations })) });
    expect(waiting).toContain('data-testid="payment-confirmations"');
    expect(waiting).toContain('Waiting for confirmations: 2 of 6,');
    expect(waiting).toContain('as of');
    const moved = view({ payment: ready(payment({ status: 'captured', confirmations })) });
    expect(moved).not.toContain('payment-confirmations');
    expect(view()).not.toContain('payment-confirmations');
  });
  it('never prints the payer’s instrument or a rail’s internals', () => {
    const out = view();
    expect(out).not.toContain('tok_TEST_must_never_show');
    expect(out).not.toContain('rail internals');
  });
  it('leads with the amount and status, shows the stored fee, net and the rule, and offers Refund while money remains', () => {
    const out = view({
      payment: ready(
        payment({
          pricingSnapshot: {
            fee: '1.20',
            assetCode: 'USDT',
            appliedLayer: 'tier',
            ruleId: 'r',
            feeBps: 150,
            flatFee: '0.30',
            spreadBps: null,
            roundingBeneficiary: 'platform',
            roundingMode: 'ceil',
            bookedFee: null,
            reserveAmount: null,
            recordedAt: '2026-10-14T09:00:00.000Z',
          },
        }),
      ),
    });
    expect(out).toContain('Summary');
    expect(out).toContain('1.20');
    expect(out).toContain('124.30');
    expect(out).toContain('Your tier’s rate, 1.5% + 0.30 USDT');
    expect(out).toContain('href="/pay/refunds/new?payment=aa000001-0000-4000-8000-000000000001"');
    expect(out).not.toContain('Fee details weren’t recorded');
  });
  it('explains a negative "Net after refunds": the fee is kept on a refund', () => {
    const base = { amount: '10', capturedAmount: '10', pricingSnapshot: { fee: '2' } };
    const negative = view({ payment: ready(payment({ ...base, refundedAmount: '10', status: 'refunded' })) });
    expect(negative).toContain('Net after refunds');
    expect(negative).toContain('Below zero because the processing fee is kept when a payment is refunded.');
    const positive = view({ payment: ready(payment({ ...base, refundedAmount: '3' })) });
    expect(positive).toContain('Net after refunds');
    expect(positive).not.toContain('Below zero because');
  });
  it('says plainly when the fee was not recorded, and offers no Refund once everything is refunded', () => {
    const out = view({ payment: ready(payment({ pricingSnapshot: null, refundedAmount: '125.5', status: 'refunded' })) });
    expect(out).toContain('The fee taken is shown on the settlement.');
    expect(out).not.toContain('/pay/refunds/new');
  });
  it('says a captured payment that has not settled yet is charged when it settles, not that a settlement shows the fee', () => {
    const out = view({ payment: ready(payment({ pricingSnapshot: null, status: 'captured', refundedAmount: '0' })) });
    expect(out).toContain('The fee is taken when this payment settles.');
    expect(out).not.toContain('shown on the settlement');
  });
  it('lists refunds from the refunds list when it is available, and the activity recorded for the payment', () => {
    const out = view({
      refunds: [
        {
          id: 'ff000001-0000-4000-8000-000000000001',
          refundId: 'TEST-refund-1',
          paymentId: 'aa000001-0000-4000-8000-000000000001',
          amount: '20',
          assetId: 'USDT',
          status: 'posted',
          createdAt: '2026-10-14T10:00:00.000Z',
        },
      ],
      activity: [
        {
          id: 'a1',
          occurredAt: '2026-10-14T09:01:00.000Z',
          actorId: 'system',
          action: 'payment_captured',
          objectType: 'payment',
          objectId: 'x',
          detail: {},
        },
      ],
    });
    expect(out).toContain('href="/pay/refunds/ff000001-0000-4000-8000-000000000001"');
    expect(out).toContain('Refund sent');
    expect(out).toContain('Payment captured');
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
    expect(out).toContain('Fraud');
    expect(view()).toContain('The customer has not disputed this payment.');
    expect(view({ payment: ready(payment({ status: 'disputed' })) })).toContain('no dispute record could be linked');
  });
  it('shows loading, a not-found refusal that does not say whose payment it is, and an unreachable service', () => {
    expect(view({ payment: loading })).toContain('aria-busy="true"');
    const missing = html(
      <PaymentDetailView
        payment={{ status: 'failed', failure: portalRefusal('rPaymentNotFound') }}
        history={loading}
        refunds={loading}
        activity={[]}
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
