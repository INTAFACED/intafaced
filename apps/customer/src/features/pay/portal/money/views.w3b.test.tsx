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
import { ApprovalsView } from './Approvals';
import { LimitsView } from './Limits';
import { PayoutDetailView, PayoutsView } from './Payouts';
import { PricingView } from './Pricing';
import { portalRefusal } from '../refusal';
import { SettlementDetailView, SettlementsView } from './Settlements';
import * as p from '../schemas';
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
const down = failed('', 503, 'unreachable');
const soon = failed('pay.not_built', 501, 'not_supported');
const forbidden = failed('pay.merchant_forbidden', 403);
const noop = () => undefined;
/** Every page: no service code may reach the reader (B8). */
const expectPlain = (out: string) => expect(out).not.toMatch(/pay\.[a-z_]+/);
const NOW = Date.parse('2026-10-15T12:00:00.000Z');
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
const approval = (patch: Partial<p.Approval> = {}): p.Approval => ({
  approvalId: 'cc000001-0000-4000-8000-000000000001',
  merchantId: '11111111-1111-4111-8111-111111111111',
  settlementId: 'bb000001-0000-4000-8000-000000000001',
  amount: '985',
  assetCode: 'USDT',
  payloadHash: `sha256:${'a'.repeat(64)}`,
  status: 'pending',
  makerUserId: 'TEST-maker',
  checkerUserId: null,
  createdAt: '2026-10-15T09:00:00.000Z',
  decidedAt: null,
  expiresAt: '2026-10-16T09:00:00.000Z',
  ...patch,
});
const profile = (patch: Partial<p.ControlProfile> = {}): p.ControlProfile => ({
  merchantId: 'm',
  tierId: 'test-tier-a',
  archetypeId: null,
  caps: [
    { kind: 'daily_intake', assetCode: 'USDT', limit: '20000' },
    { kind: 'beneficiaries_per_day', limit: 5 },
  ],
  pricing: [
    {
      layer: 'tier',
      scopeId: 'test-tier-a',
      assetCode: 'USDT',
      bands: [
        { fromAmount: '0', feeBps: 150, flatFee: null },
        { fromAmount: '10000', feeBps: 120, flatFee: '0.25' },
      ],
      spreadBps: 40,
      roundingBeneficiary: 'platform',
    },
  ],
  reserve: { rollingReserveBps: 500, holdDays: 7 },
  version: '4',
  updatedAt: '2026-10-03T00:00:00.000Z',
  ...patch,
});
const unconfigured = profile({ tierId: null, caps: null, pricing: null, reserve: null, version: '0', updatedAt: null });
const usage = (rows: p.Usage['rows'] = []): p.Usage => ({ merchantId: 'm', tierId: 'test-tier-a', asOf: '2026-10-15T11:59:40.000Z', rows });
describe('settlements list (P26)', () => {
  const view = (patch: Partial<Parameters<typeof SettlementsView>[0]> = {}) =>
    html(
      <SettlementsView
        snapshot={ready(snapshot())}
        period="rolling_30d"
        setPeriod={noop}
        halts={quietHalts}
        list={ready([settlement(), settlement({ id: 'bb000002-0000-4000-8000-000000000002', status: 'failed', window: 'TEST-2026-W40' })])}
        loadedAt="2026-10-15T12:00:00.000Z"
        status=""
        setStatus={noop}
        asset=""
        setAsset={noop}
        q=""
        setQ={noop}
        limit={25}
        setLimit={noop}
        retry={noop}
        {...patch}
      />,
    );
  it('shows gross, fees and net for the period with an as-of line, and a table with status words', () => {
    const out = view();
    expect(out).toContain('Gross');
    expect(out).toContain('2,400.5');
    expect(out).toContain('36');
    expect(out).toContain('As of');
    expect(out).toContain('Ready to pay out');
    expect(out).toContain('Failed');
    expect(out).toContain('Did not complete. Open it to see where it stands.');
    expect(out).toContain('href="/pay/settlements/bb000001-0000-4000-8000-000000000001"');
    expect(out).toContain('Download CSV');
    expectPlain(out);
  });
  it('is honest that there is no date filter yet', () => {
    expect(view()).toContain('filter settlements by date');
  });
  it('explains empty, filtered-empty, loading, unreachable and refused', () => {
    expect(view({ list: ready<p.Settlement[]>([]) })).toContain('No settlements yet');
    expect(view({ list: ready<p.Settlement[]>([]), status: 'failed' })).toContain('No settlements with that status');
    expect(view({ q: 'nope' })).toContain('No loaded settlement matches');
    expect(view({ list: loading })).toContain('aria-busy="true"');
    expect(view({ list: down })).toContain('Try again');
    expect(view({ list: forbidden })).toContain('Your account does not have access to this.');
  });
  it('shows a pause on settlements', () => {
    const out = view({
      halts: ready<p.HaltStatus>({
        readable: true,
        states: [{ scope: 'settlement', target: { level: 'merchant', merchantId: 'm' }, halted: true, changedAt: null }],
      }),
    });
    expect(out).toContain('Settlements are paused.');
    expect(out).toContain('INTAFACED has paused this on your account');
  });
});
describe('settlement statement (P27)', () => {
  const view = (patch: Partial<Parameters<typeof SettlementDetailView>[0]> = {}) =>
    html(<SettlementDetailView settlement={ready(settlement())} control={ready(profile())} halts={quietHalts} retry={noop} {...patch} />);
  it('shows the statement, the tie-out check, the reserve set-up and what is not built yet', () => {
    const out = view();
    expect(out).toContain('Statement');
    expect(out).toContain('Gross: everything paid in for this window');
    expect(out).toContain('Checked: gross minus fees equals net, to the last decimal.');
    expect(out).toContain('Your account holds back a rolling reserve of 5.00%.');
    expect(out).toContain('It is held for 7 days.');
    expect(out).toContain('how much of this settlement is held in reserve');
    expect(out).toContain('Fees by line and the price that applied');
    expect(out).toContain('Payments in this settlement');
    expect(out).toContain('Download statement (CSV)');
    expect(out).toContain('href="/pay/payouts/bb000001-0000-4000-8000-000000000001"');
    expectPlain(out);
  });
  it('flags a statement that does not add up instead of presenting it', () => {
    const out = view({ settlement: ready(settlement({ net: '984' })) });
    expect(out).toContain('These figures do not add up');
    expect(out).not.toContain('Checked: gross minus fees equals net');
  });
  it('shows "not configured" for a reserve that was never set, never a zero', () => {
    const out = view({ control: ready(unconfigured) });
    expect(out).toContain('Not configured');
    expect(out).toContain('No reserve is set up on your account');
  });
  it('shows steps without invented times, for paid out, failed and pending', () => {
    const paid = view({ settlement: ready(settlement({ status: 'paid_out', payoutMethod: 'crypto-native', payoutRef: 'TEST-tx-1' })) });
    expect(paid).toContain('TEST-tx-1');
    expect(paid).toContain('The service does not record a time for each step yet');
    expect(view({ settlement: ready(settlement({ status: 'failed' })) })).toContain('The settlement did not complete.');
    expect(view({ settlement: ready(settlement({ status: 'pending' })) })).toContain('Still waiting to be finalised.');
  });
  it('shows loading, a missing settlement, unreachable and refused states', () => {
    expect(view({ settlement: loading })).toContain('aria-busy="true"');
    const missing = view({ settlement: { status: 'failed', failure: portalRefusal('rSettlementNotFound') } });
    expect(missing).toContain('We could not find that settlement.');
    expect(view({ settlement: down })).toContain('Try again');
    expect(view({ settlement: forbidden })).toContain('Your account does not have access to this.');
    expect(view({ control: down })).toContain('Try again');
  });
});
describe('payouts list (P28)', () => {
  const view = (patch: Partial<Parameters<typeof PayoutsView>[0]> = {}) =>
    html(
      <PayoutsView
        settlements={ready([
          settlement(),
          settlement({
            id: 'bb000002-0000-4000-8000-000000000002',
            status: 'paid_out',
            payoutMethod: 'crypto-native',
            payoutRef: 'TEST-tx-0xabc',
            window: 'TEST-2026-W40',
          }),
          settlement({ id: 'bb000003-0000-4000-8000-000000000003', status: 'pending', window: 'TEST-2026-W42' }),
        ])}
        approvals={ready([approval()])}
        halts={quietHalts}
        loadedAt="2026-10-15T12:00:00.000Z"
        state=""
        setState={noop}
        asset=""
        setAsset={noop}
        q=""
        setQ={noop}
        retry={noop}
        {...patch}
      />,
    );
  it('shows a KPI strip, chips that include who the approval is waiting on, and leaves out settlements that are not payable', () => {
    const out = view();
    expect(out).toContain('Paid out');
    expect(out).toContain('Waiting for approval');
    expect(out).toContain('Waiting for approval from your owner, an admin or finance');
    expect(out).toContain('<span class="pp-mono">TEST-tx-0xabc</span>');
    expect(out).toContain('<td><span class="muted">Not paid out yet</span></td>');
    expect(out).not.toContain('TEST-2026-W42');
    expect(out).toContain('In transit');
    expect(out).toContain('Coming soon');
    expect(out).toContain('filter payouts by destination');
    expect(out).toContain('href="/pay/payouts/bb000001-0000-4000-8000-000000000001"');
    expectPlain(out);
  });
  it('still lists payouts when approval states cannot be read, and shows them as unknown rather than ready', () => {
    const out = view({ approvals: down });
    expect(out).toContain('Approval states could not be read');
    expect(out).toContain('TEST-2026-W41');
    expect(out).toContain('Approval unknown');
    expect(out).not.toContain('Ready to pay out</span>');
    // paid out does not depend on approvals
    expect(out).toContain('TEST-tx-0xabc');
  });
  it('says a payout approved by a teammate is waiting for INTAFACED', () => {
    const out = view({ approvals: ready([approval({ checkerUserId: 'TEST-checker' })]) });
    expect(out).toContain('Approved by a teammate, waiting for INTAFACED’s sign-off');
  });
  it('explains empty, filtered-empty, loading, unreachable and refused', () => {
    expect(view({ settlements: ready<p.Settlement[]>([]) })).toContain('No payouts yet');
    expect(view({ q: 'zzz' })).toContain('No payout matches');
    expect(view({ settlements: loading })).toContain('aria-busy="true"');
    expect(view({ settlements: down })).toContain('Try again');
    expect(view({ settlements: forbidden })).toContain('Your account does not have access to this.');
  });
  it('shows a pause on payouts', () => {
    const out = view({
      halts: ready<p.HaltStatus>({
        readable: true,
        states: [{ scope: 'payout', target: { level: 'global' }, halted: true, changedAt: null }],
      }),
    });
    expect(out).toContain('Payouts are paused.');
    expect(out).toContain('INTAFACED has paused this for every account');
  });
  it('a rail halt says payouts are paused on that rail', () => {
    const out = view({
      halts: ready<p.HaltStatus>({
        readable: true,
        states: [{ scope: 'payout', target: { level: 'rail', railId: 'crypto-native' }, halted: true, changedAt: null }],
      }),
    });
    expect(out).toContain('Payouts are paused.');
    expect(out).toContain('INTAFACED has paused payouts on the crypto-native rail');
    expect(out).not.toContain('for every account');
  });
});
describe('payout detail (P30)', () => {
  const base = (patch: Partial<Parameters<typeof PayoutDetailView>[0]> = {}): Parameters<typeof PayoutDetailView>[0] => ({
    portal,
    settlement: ready(settlement()),
    approvals: ready([approval()]),
    usage: ready(
      usage([
        { kind: 'daily_payout', assetCode: 'USDT', limit: '10000', used: '9800', remaining: '200', resetsAt: '2026-10-16T00:00:00.000Z' },
      ]),
    ),
    halts: quietHalts,
    me: 'TEST-checker',
    role: 'finance',
    now: NOW,
    testValues: true,
    reload: noop,
    ...patch,
  });
  const view = (patch: Partial<Parameters<typeof PayoutDetailView>[0]> = {}) => html(<PayoutDetailView {...base(patch)} />);
  it('shows key facts, the approval timeline and trail, the decision form and the cap', () => {
    const out = view();
    expect(out).toContain('Waiting for approval');
    expect(out).toContain('Payout requested');
    expect(out).toContain('By TEST-maker');
    expect(out).toContain('Approval trail');
    expect(out).toContain('sha256:aaaaaaaaaaaaaaa');
    expect(out).toContain('Approve payout');
    expect(out).toContain('Reject payout');
    expect(out).toContain('Write a reason of at least 3 characters to enable the buttons.');
    expect(out).toContain('Your daily payout limit');
    expect(out).toContain('9,800');
    expect(out).toContain('TEST VALUE');
    expect(out).toContain('Destination screening and conversion');
    expectPlain(out);
  });
  it('stops the person who asked from approving, with the reason in words', () => {
    const out = view({ me: 'TEST-maker' });
    expect(out).toContain('You asked for this payout, so someone else on your team has to decide it.');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Approve payout<\/button>/);
    expect(out).toContain('Cancel my request');
  });
  it('stops a role that cannot decide, and says which roles can', () => {
    const out = view({ role: 'viewer' });
    expect(out).toContain('Only the owner, an admin or finance can approve or reject payouts.');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Approve payout<\/button>/);
  });
  it('banners a voided approval and shows a failed payout without a code', () => {
    const voided = view({ approvals: ready([approval({ status: 'voided', decidedAt: '2026-10-15T09:10:00.000Z' })]) });
    expect(voided).toContain('The approval on this payout no longer counts');
    expect(voided).not.toContain('Approve payout');
    const fail = view({ settlement: ready(settlement({ status: 'failed' })), approvals: ready<p.Approval[]>([]) });
    expect(fail).toContain('This payout did not complete. The reason is not shown here yet.');
    expectPlain(fail);
  });
  it('shows a paid payout with its trail and an approver, and a payout with no request', () => {
    const paid = view({
      settlement: ready(settlement({ status: 'paid_out', payoutMethod: 'crypto-native', payoutRef: 'TEST-tx-1' })),
      approvals: ready([approval({ status: 'consumed', checkerUserId: 'TEST-checker', decidedAt: '2026-10-15T10:00:00.000Z' })]),
    });
    expect(paid).toContain('Approved');
    expect(paid).toContain('You');
    expect(paid).toContain('TEST-tx-1');
    expect(paid).not.toContain('Approve payout');
    expect(view({ approvals: ready<p.Approval[]>([]) })).toContain('No approval has been requested for this payout.');
  });
  it('shows "Approval unknown" when approvals cannot be read, and no decision form', () => {
    const out = view({ approvals: down });
    expect(out).toContain('Approval unknown');
    expect(out).not.toContain('Approve payout');
    expect(out).not.toContain('Ready to pay out</span>');
  });
  it('shows a names where the portal has them in the trail and the timeline', () => {
    const out = view({ names: new Map([['TEST-maker', 'Maya Finance']]) });
    expect(out).toContain('Maya Finance');
    expect(out).toContain('By Maya Finance');
  });
  it('shows "not configured" for a missing daily payout limit, never a number', () => {
    const out = view({ usage: ready(usage([])) });
    expect(out).toContain('Not configured');
    expect(out).toContain('No daily payout limit is set for this asset.');
  });
  it('shows loading, not found, unreachable and refused states', () => {
    expect(view({ settlement: loading })).toContain('aria-busy="true"');
    expect(view({ settlement: { status: 'failed', failure: portalRefusal('rPayoutNotFound') } })).toContain(
      'We could not find that payout.',
    );
    expect(view({ settlement: down })).toContain('Try again');
    expect(view({ settlement: forbidden })).toContain('Your account does not have access to this.');
    expect(view({ usage: soon })).toContain('Coming soon');
  });
});
describe('payout approvals queue (P31)', () => {
  const view = (patch: Partial<Parameters<typeof ApprovalsView>[0]> = {}) =>
    html(
      <ApprovalsView
        portal={portal}
        list={ready([
          approval(),
          approval({
            approvalId: 'cc000002-0000-4000-8000-000000000002',
            makerUserId: 'TEST-checker',
            amount: '40',
            createdAt: '2026-10-15T11:00:00.000Z',
          }),
          approval({
            approvalId: 'cc000003-0000-4000-8000-000000000003',
            status: 'rejected',
            checkerUserId: 'TEST-checker',
            decidedAt: '2026-10-14T00:00:00.000Z',
          }),
        ])}
        halts={quietHalts}
        loadedAt="2026-10-15T12:00:00.000Z"
        now={NOW}
        me="TEST-checker"
        role="finance"
        status="pending"
        setStatus={noop}
        q=""
        setQ={noop}
        reload={noop}
        {...patch}
      />,
    );
  it('shows the KPI strip, age and expiry chips on every waiting request, and an approve button for others’ requests', () => {
    const out = view();
    expect(out).toContain('Waiting for a decision');
    expect(out).toContain('Waiting for you');
    expect(out).toContain('Your requests');
    expect(out).toContain('Oldest waiting');
    expect(out).toContain('Next to expire');
    expect(out).toMatch(/Waiting<!-- --> <!-- -->3 h/);
    expect(out).toMatch(/Expires in<!-- --> <!-- -->21 h/);
    expect(out).toContain('As of');
    expect(out).toContain('Approve payout');
    expect(out).toContain('Choose to be told when a payout is waiting');
    expectPlain(out);
  });
  it('shows the older request first, and hides decided requests under the default "waiting" filter', () => {
    const out = view();
    expect(out.indexOf('>985.00<')).toBeGreaterThan(-1);
    expect(out.indexOf('>985.00<')).toBeLessThan(out.indexOf('>40.00<'));
    expect(out).not.toContain('A second person rejected it');
  });
  it('disables a request you made, with the reason in words', () => {
    const out = view({ me: 'TEST-maker' });
    expect(out).toContain('You asked for this payout, so someone else on your team has to decide it.');
  });
  it('tells a role that cannot decide why, and does not count requests as theirs', () => {
    const out = view({ role: 'developer' });
    expect(out).toContain('Your role cannot decide payouts');
    expect(out).toContain('Only the owner, an admin or finance can approve or reject payouts.');
  });
  it('shows every request when asked, including decided ones', () => {
    const out = view({ status: 'all' });
    expect(out).toContain('A second person rejected it');
  });
  it('explains empty, nothing waiting, no match, loading, unreachable and refused', () => {
    expect(view({ list: ready<p.Approval[]>([]) })).toContain('No payout requests');
    expect(view({ list: ready([approval({ status: 'approved' })]) })).toContain('Nothing is waiting');
    expect(view({ q: 'zzz' })).toContain('No request matches');
    expect(view({ list: loading })).toContain('aria-busy="true"');
    expect(view({ list: down })).toContain('Try again');
    expect(view({ list: forbidden })).toContain('Your account does not have access to this.');
  });
  it('expired and past-expiry requests cannot be decided', () => {
    const out = view({ list: ready([approval({ expiresAt: '2026-10-15T11:00:00.000Z' })]) });
    expect(out).toContain('Past its expiry');
    expect(out).toContain('This request has expired. Ask for the payout again.');
  });
  it('shows a payout pause', () => {
    const out = view({
      halts: ready<p.HaltStatus>({
        readable: true,
        states: [{ scope: 'payout', target: { level: 'global' }, halted: true, changedAt: null }],
      }),
    });
    expect(out).toContain('Payouts are paused.');
  });
});
describe('pricing and fees (P36)', () => {
  const view = (patch: Partial<Parameters<typeof PricingView>[0]> = {}) =>
    html(
      <PricingView portal={portal} merchantId="m" control={ready(profile())} readAt="2026-10-15T12:00:00.000Z" retry={noop} {...patch} />,
    );
  it('shows the tier, version, in-force date, reserve, a band table and the conversion spread', () => {
    const out = view();
    expect(out).toContain('test-tier-a');
    expect(out).toContain('In force since');
    expect(out).toContain('10/3/2026');
    expect(out).toContain('1.50%');
    expect(out).toContain('(150 bps)');
    expect(out).toContain('1.20%');
    expect(out).toContain('0.25');
    expect(out).toContain('0.40%');
    expect(out).toContain('Set for your tier');
    expect(out).toContain('go to INTAFACED');
    expect(out).toContain('Download schedule (CSV)');
    expect(out).toContain('As of');
    expectPlain(out);
  });
  it('includes a fee calculator that needs an amount before it runs, and a history that has not arrived', () => {
    const out = view();
    expect(out).toContain('Fee calculator');
    expect(out).toContain('same engine as live payments');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Work out the fee<\/button>/);
    expect(out).toContain('History of price changes');
    expect(out).toContain('Coming soon');
  });
  it('shows "not configured" and no fee at all when pricing was never published', () => {
    const out = view({ control: ready(unconfigured) });
    expect(out).toContain('Not configured');
    expect(out).toContain('INTAFACED has not published pricing for your account.');
    expect(out).toContain('No tier assigned');
    expect(out).toContain('No reserve is set up');
    expect(out).not.toContain('Download schedule');
    expect(out).toContain('The calculator needs published pricing');
    expect(out).not.toMatch(/\d+\.\d\d%/);
  });
  it('shows a spread that is not set as not configured', () => {
    const out = view({ control: ready(profile({ pricing: [{ ...profile().pricing![0]!, spreadBps: null }] })) });
    expect(out).toContain('No spread is set');
  });
  it('shows loading, unreachable, refused and arrives-soon', () => {
    expect(view({ control: loading })).toContain('aria-busy="true"');
    expect(view({ control: down })).toContain('Try again');
    expect(view({ control: forbidden })).toContain('Your account does not have access to this.');
    expect(view({ control: soon })).toContain('Coming soon');
  });
});
describe('limits and tier (P37)', () => {
  const rows: p.Usage['rows'] = [
    { kind: 'per_payment', assetCode: 'USDT', limit: '5000', used: null, remaining: null, resetsAt: null },
    { kind: 'daily_intake', assetCode: 'USDT', limit: '20000', used: '14200.5', remaining: '5799.5', resetsAt: '2026-10-16T00:00:00.000Z' },
    { kind: 'daily_payout', assetCode: 'USDT', limit: '10000', used: '10000', remaining: '0', resetsAt: '2026-10-16T00:00:00.000Z' },
    { kind: 'beneficiaries_per_day', assetCode: null, limit: '5', used: '2', remaining: '3', resetsAt: '2026-10-16T00:00:00.000Z' },
  ];
  const view = (patch: Partial<Parameters<typeof LimitsView>[0]> = {}) =>
    html(<LimitsView control={ready(profile())} usage={ready(usage(rows))} now={NOW} testValues={false} retry={noop} {...patch} />);
  it('shows the tier, usage bars with exact figures and reset times, and an as-of line', () => {
    const out = view();
    expect(out).toContain('test-tier-a');
    expect(out).toContain('role="progressbar"');
    expect(out).toContain('aria-valuenow="71"');
    expect(out).toContain('14,200.5');
    expect(out).toContain('5,799.5');
    expect(out).toContain('Money in per day');
    expect(out).toContain('New payout destinations per day');
    expect(out).toContain('As of');
    expect(out).toContain('20 s behind');
    expectPlain(out);
  });
  it('says a full limit is used up in words, not only in colour', () => {
    expect(view()).toContain('This limit is used up.');
  });
  it('lists every kind of limit; one nobody set says "not configured" and shows no number', () => {
    const out = view();
    expect(out).toContain('Money in per month');
    expect(out).toContain('Not configured');
    expect(out).toContain('Limits set');
    expect(out).toContain('4 / 5');
  });
  it('labels figures as test values while the account is not live', () => {
    expect(view({ testValues: true })).toContain('TEST VALUE');
    expect(view({ testValues: false })).not.toContain('TEST VALUE');
  });
  it('shows everything as not configured, with no bars, when no limits were ever set', () => {
    const out = view({ control: ready(unconfigured), usage: ready({ ...usage([]), tierId: null }) });
    expect(out).toContain('INTAFACED has not set limits for your account yet.');
    expect(out).toContain('No tier assigned');
    expect(out).not.toContain('role="progressbar"');
    expect(out).toContain('0 / 5');
  });
  it('says tier ladder and increase requests have not arrived, rather than inventing them', () => {
    const out = view();
    expect(out).toContain('Tiers and what unlocks next');
    expect(out).toContain('Ask for a higher limit');
    expect(out).toContain('Coming soon');
  });
  it('shows the limits it knows when usage cannot be read, with a retry', () => {
    const out = view({ usage: down });
    expect(out).toContain('Try again');
    expect(out).toContain('20,000');
  });
  it('shows loading, unreachable, refused and arrives-soon', () => {
    expect(view({ control: loading })).toContain('aria-busy="true"');
    expect(view({ control: down, usage: down })).toContain('Try again');
    expect(view({ control: forbidden, usage: forbidden })).toContain('Your account does not have access to this.');
    expect(view({ control: soon, usage: soon })).toContain('Coming soon');
  });
});
