import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
// A review dialog is closed until clicked and there is no browser here: draw its body in place.
vi.mock('../ui/PortalReview', async () => {
  const { ExactMoneyScope } = await import('../ui/ExactMoneyScope');
  return {
    PortalReview: ({ review, title }: { review?: ReactNode; title: string }) => (
      <div data-review={title}>
        <ExactMoneyScope>{review}</ExactMoneyScope>
      </div>
    ),
  };
});

import type { Resource } from '../../../../shared/resource';
import type { PortalApi } from '../api';
import { EntityList } from '../ui/EntityList';
import { chromeCopy } from '../chrome/copy';
import { withMoneyAccess } from '../access/money-test-kit';
import { ApprovalDecision } from './Approvals';
import { MoneyFailure, NamedBlocker } from './common';
import { ConversionChip } from './Conversion';
import { PayoutDetailView } from './Payouts';
import { TierLadder } from './Limits';
import { calculatorAssets, TierFeeTable } from './Pricing';
import { EffectiveFeeView, EffectiveRatesList } from './fee-rate';
import type { TierList } from './schemas';
import { NoPayable } from './PayoutNew';
import { RefundChip } from './Refunds';
import { statementColumns } from './Statement';
import { mc } from './copy';
import type { Approval, HaltStatus, Settlement, Usage } from '../schemas';
import type { Lifecycle, StatementLine } from './schemas';

// Everything below is TEST DATA written for these tests. None of it is a real merchant, customer or amount.
const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const ME = 'TEST-me';
const ready = <T,>(data: T): Resource<T> => ({ status: 'ready', data });
const noop = () => undefined;
const portal = { userId: ME } as unknown as PortalApi;
const DEST = { railId: 'crypto-native', destinationKind: 'crypto', destinationMasked: '0x7a3f…4421' };
const approval = (patch: Partial<Approval>): Approval => ({
  approvalId: 'cc000001-0000-4000-8000-000000000001',
  merchantId: '11111111-1111-4111-8111-111111111111',
  settlementId: 'bb000002-0000-4000-8000-000000000002',
  amount: '12.345678',
  assetCode: 'USDT',
  payloadHash: `sha256:${'a'.repeat(64)}`,
  status: 'pending',
  makerUserId: 'TEST-maker',
  checkerUserId: null,
  createdAt: '2026-10-15T09:00:00.000Z',
  decidedAt: null,
  expiresAt: '2026-10-16T09:00:00.000Z',
  ...DEST,
  ...patch,
});
const settlement = (patch: Partial<Settlement> = {}): Settlement => ({
  id: 'bb000002-0000-4000-8000-000000000002',
  merchantId: '11111111-1111-4111-8111-111111111111',
  window: 'TEST-2026-W40',
  assetId: 'USDT',
  gross: '1000',
  fees: '15',
  net: '985',
  payoutMethod: 'crypto-native',
  payoutRef: 'TEST-tx-0xabc',
  status: 'paid_out',
  createdAt: '2026-10-01T09:00:00.000Z',
  sentAt: '2026-10-05T09:00:00.000Z',
  settledAt: '2026-10-05T10:00:00.000Z',
  ...patch,
});
const noHalts = ready<HaltStatus>({ readable: true, states: [] });
const noUsage = ready<Usage>({ merchantId: 'm', tierId: null, asOf: '2026-10-15T11:59:00.000Z', rows: [] });
// The payout lifecycle read is not released, so the page builds its trail from the settlement and every approval attempt.
const noLifecycle: Resource<Lifecycle> = {
  status: 'failed',
  failure: { ok: false, reason: 'error', code: 'pay.not_built', message: 'pay.not_built' },
};

describe('payout detail', () => {
  const rejected = approval({
    approvalId: 'cc000005-0000-4000-8000-000000000005',
    status: 'rejected',
    checkerUserId: 'TEST-checker',
    createdAt: '2026-10-02T09:00:00.000Z',
    decidedAt: '2026-10-02T11:00:00.000Z',
  });
  const paid = approval({
    approvalId: 'cc000003-0000-4000-8000-000000000003',
    status: 'consumed',
    checkerUserId: 'TEST-checker',
    createdAt: '2026-10-03T09:00:00.000Z',
    decidedAt: '2026-10-03T11:00:00.000Z',
  });
  const render = (approvals: Approval[], lifecycle = noLifecycle) =>
    renderToString(
      <PayoutDetailView
        portal={portal}
        settlement={ready(settlement())}
        lifecycle={lifecycle}
        approvals={ready(approvals)}
        usage={noUsage}
        halts={noHalts}
        role="owner"
        now={NOW}
        names={new Map()}
        readAt={null}
        reload={noop}
      />,
    );
  it('reads a rejected-then-paid payout in order and ends on Paid out, not Rejected', () => {
    // The lifecycle read is not available here, so the page builds the trail from the settlement and every approval attempt.
    const out = render([paid, rejected]).replace(/<!-- -->/g, '');
    const firstRejected = out.indexOf('Rejected');
    const lastPaid = out.lastIndexOf('Paid out');
    expect(firstRejected).toBeGreaterThan(-1);
    expect(lastPaid).toBeGreaterThan(firstRejected);
    // Nothing after the final "Paid out" in the trail names a rejection.
    const trail = out.slice(out.indexOf('What happened'), out.indexOf('Approval requests'));
    expect(trail.lastIndexOf('Rejected')).toBeLessThan(trail.lastIndexOf('Paid out'));
  });
  it('names the destination from the request and never a raw id as the heading', () => {
    const out = render([paid]);
    expect(out).toContain('Wallet 0x7a3f…4421');
    expect(out).toContain('Crypto network');
  });
  it('shows the deciding person as You when it is the signed-in user', () => {
    const out = render([
      approval({ makerUserId: ME, status: 'rejected', checkerUserId: 'TEST-checker', decidedAt: '2026-10-02T11:00:00.000Z' }),
    ]);
    expect(out).toContain('You');
  });
  it('shows the pause banner and a plain words status for a failed payout', () => {
    const out = renderToString(
      <PayoutDetailView
        portal={portal}
        settlement={ready(
          settlement({
            status: 'failed',
            settledAt: null,
            failedAt: '2026-10-05T10:00:00.000Z',
            failure: { code: 'pay.rail_declined', message: 'The payment network declined this payout.' },
          }),
        )}
        lifecycle={noLifecycle}
        approvals={ready([])}
        usage={noUsage}
        halts={noHalts}
        role="owner"
        now={NOW}
        names={new Map()}
        readAt={null}
        reload={noop}
      />,
    );
    expect(out).toContain('The payment network declined this payout.');
    expect(out).not.toMatch(/pay\.[a-z_]+/);
    // Retry is held until PAYOUTONCE lands (payout-retry.ts): no button, no link into the payout form, a pointer to support.
    expect(out).not.toContain('Try this payout again');
    expect(out).not.toContain('/pay/payouts/new');
    expect(out).toContain('Retrying is paused while we fix a safety issue.');
    expect(out).toContain('Contact support');
  });
  it('offers no retry on a payout that was paid', () => {
    expect(render([paid])).not.toContain('Try this payout again');
  });
});

describe('payout form with nothing to start', () => {
  it('names the settlements waiting for approval and links to them', () => {
    const out = renderToString(<NoPayable waitingN={2} />);
    expect(out).toContain('2 settlements are waiting for a second person');
    expect(out).toContain('href="/pay/approvals?status=pending"');
    expect(renderToString(<NoPayable waitingN={1} />)).toContain('1 settlement is waiting');
  });
  it('says nothing is finalised only when nothing is waiting', () => {
    const out = renderToString(<NoPayable waitingN={0} />);
    expect(out).toContain('Nothing is ready to pay out');
    expect(out).not.toContain('approval');
  });
});

describe('approval review', () => {
  it('shows where the money goes and the exact amount in the confirm dialog', () => {
    const out = renderToString(
      <ApprovalDecision portal={portal} approval={approval({})} me="TEST-checker" role="finance" now={NOW} onDone={noop} />,
    );
    expect(out).toContain('12.345678');
    expect(out).toContain('Wallet 0x7a3f…4421');
    expect(out).toContain('Crypto network');
  });
  it('says plainly when a request does not name its destination', () => {
    const out = renderToString(
      <ApprovalDecision
        portal={portal}
        approval={approval({ destinationMasked: undefined, railId: undefined, destinationKind: undefined })}
        me="TEST-checker"
        role="finance"
        now={NOW}
        onDone={noop}
      />,
    );
    expect(out).toContain('Not shown here');
  });
  const decide = (remaining: string | null) =>
    renderToString(
      <ApprovalDecision
        portal={portal}
        approval={approval({ amount: '965.55' })}
        me="TEST-checker"
        role="finance"
        now={NOW}
        remaining={remaining}
        onDone={noop}
      />,
    );
  it('warns before approving more than is left of today’s payout limit, with the exact amount left', () => {
    const out = decide('200').replace(/<!-- -->/g, '');
    expect(out).toContain('more than you have left of today’s payout limit (<span class="numeric pp-money pp-nowrap">200.00 ');
    expect(out).toContain('pp-callout--warn');
  });
  it('shows every digit of the amount left inside the review, where the callout rounds it', () => {
    const out = decide('200.123456').replace(/<!-- -->/g, '');
    // The review is drawn in an exact scope, so the over-limit line there carries the full figure.
    const at = out.indexOf('data-review="Approve payout"');
    expect(out.slice(at)).toMatch(/>200\.123456 /);
    expect(out.slice(0, at)).toContain('>200.12 ');
    expect(out.slice(0, at)).not.toMatch(/>200\.123456/);
  });
  it('does not warn when the payout fits, or when the limit is unknown', () => {
    expect(decide('965.55')).not.toContain('payout limit');
    expect(decide('1000')).not.toContain('payout limit');
    expect(decide(null)).not.toContain('payout limit');
  });
});

describe('statement table', () => {
  const lines: StatementLine[] = [
    {
      id: 'a',
      at: '2026-10-14T09:00:00.000Z',
      assetId: 'USDT',
      kind: 'payment_captured',
      amount: '12.345678',
      account: 'clearing',
      direction: 'debit',
      runningClearing: '20',
      runningProceeds: null,
      runningOrder: 'clear',
    },
  ];
  const t = mc.t;
  it('draws a Balance after column only when asked', () => {
    const table = (show: boolean) =>
      renderToString(
        <EntityList label="x" rows={lines} rowKey={(l) => l.id} columns={statementColumns(t, false, show)} card={() => ({ title: 'x' })} />,
      );
    expect(table(true)).toContain('Balance after');
    expect(table(false)).not.toContain('Balance after');
    expect(table(false)).toContain('12.345678');
    expect(table(false)).toContain('Payment received');
  });
});

describe('statement fee lines', () => {
  const fee: StatementLine = {
    id: 'f',
    at: '2026-10-14T23:30:00.000Z',
    assetId: 'USD',
    kind: 'fee',
    amount: '1.2',
    account: 'houseFees',
    direction: 'credit',
    runningClearing: null,
    runningProceeds: null,
    runningOrder: 'clear',
  };
  const out = renderToString(
    <EntityList label="x" rows={[fee]} rowKey={(l) => l.id} columns={statementColumns(mc.t, false, false)} card={() => ({ title: 'x' })} />,
  );
  it('signs a fee as taken and calls it so', () => {
    expect(out.replace(/<!-- -->/g, '')).toContain('− ');
    expect(out).toContain('1.20');
    expect(out).toContain('Fee taken');
  });
  it('labels every time UTC, and pads money to two places', () => {
    expect(out).toMatch(/Oct 1[45], 2026, \d+:30 [AP]M/);
  });
});

describe('words', () => {
  it('names the reason a part is not live, never "coming soon"', () => {
    const out = renderToString(
      <NamedBlocker title="Destinations" why="reasonLists" needs="merchant.payoutDestinations.list">
        x
      </NamedBlocker>,
    );
    expect(out).toContain(chromeCopy.t('reasonLists'));
    expect(out.toLowerCase()).not.toContain('coming soon');
  });
  it('gives refunds and conversions plain status words', () => {
    expect(renderToString(<RefundChip status="posted" />)).toContain('In progress');
    expect(renderToString(<RefundChip status="reversed" />)).toContain('Reversed');
    expect(renderToString(<ConversionChip status="partially_filled" />)).toContain('Partly done');
    expect(renderToString(<ConversionChip status="something_new" />)).toContain('Update');
  });
});

describe('a busy statement', () => {
  it('reads as a calm wait with a retry, not as an error', () => {
    const busy = {
      ok: false,
      reason: 'error',
      code: 'pay.statement_busy',
      message: 'pay.statement_busy: A statement for this merchant is already in progress.',
    } as never;
    const html = renderToString(<MoneyFailure result={busy} retry={noop} />);
    expect(html).toContain('Statement is being prepared, try again in a minute.');
    expect(html).toContain('Try again');
    expect(html).not.toContain('already in progress');
  });
});

describe('an approved payout is not a dead end', () => {
  const approved = approval({
    status: 'approved',
    checkerUserId: 'TEST-checker',
    decidedAt: '2026-10-15T10:00:00.000Z',
    expiresAt: '2026-10-17T10:00:00.000Z',
  });
  const posted = settlement({ status: 'posted', settledAt: null, sentAt: null, payoutMethod: null, payoutRef: null });
  const render = (role: 'owner' | 'finance' | null, approvals: Approval[] = [approved], usage: typeof noUsage = noUsage, held = true) =>
    renderToString(
      withMoneyAccess(
        <PayoutDetailView
          portal={portal}
          settlement={ready(posted)}
          lifecycle={noLifecycle}
          approvals={ready(approvals)}
          usage={usage}
          halts={noHalts}
          role={role}
          now={NOW}
          names={new Map()}
          readAt={null}
          reload={noop}
        />,
        held,
      ),
    );
  it('switches "Send this payout" off, with the reason, when the person cannot begin a payout', () => {
    const out = render('owner', [approved], noUsage, false).replace(/<!-- -->/g, '');
    expect(out).toContain('Send this payout');
    expect(out).toContain('Only the account owner can send payouts.');
    expect(out).not.toContain('href="/pay/payouts/new');
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Send this payout/);
  });
  it('offers the owner "Send this payout" and says who approved it and until when', () => {
    const out = render('owner').replace(/<!-- -->/g, '');
    expect(out).toContain('Send this payout');
    expect(out).toContain('href="/pay/payouts/new?settlement=bb000002-0000-4000-8000-000000000002"');
    expect(out).toContain('Approved by TEST-che');
    expect(out).toContain('The money has not been sent yet.');
    expect(out).toContain('Send it before');
    expect(out).not.toContain('Request this payout');
  });
  it('says an approved payout is over what is left of today’s limit, next to a missing send button', () => {
    const row = (remaining: string) => ({
      kind: 'daily_payout',
      assetCode: posted.assetId,
      limit: '2000',
      used: '0',
      remaining,
      resetsAt: null,
    });
    const tight = ready<Usage>({ merchantId: 'm', tierId: null, asOf: '2026-10-15T11:59:00.000Z', rows: [row('1.00')] as never });
    const out = render('owner', [approved], tight).replace(/<!-- -->/g, '');
    expect(out).toContain('more than you have left of today’s payout limit, so it cannot be sent yet');
    expect(out).not.toContain('href="/pay/payouts/new');
    const roomy = ready<Usage>({ merchantId: 'm', tierId: null, asOf: '2026-10-15T11:59:00.000Z', rows: [row('999999999')] as never });
    expect(render('owner', [approved], roomy)).toContain('href="/pay/payouts/new');
  });
  it('tells anyone but the owner that only the owner can send it, and offers no button', () => {
    const out = render('finance').replace(/<!-- -->/g, '');
    expect(out).not.toContain('href="/pay/payouts/new');
    expect(out).toContain('Only the account owner can send a payout. Ask them to send it before');
  });
  it('leaves a role the portal could not read to the service', () => {
    expect(render(null)).toContain('Send this payout');
  });
  it('says approving does not send it, so the dialog matches what happens next', () => {
    // The dialog's wording is printed by the review dialog itself; here it is the words the page hands it.
    const words = mc.t('approveBody');
    expect(words).toContain('does not send it: the account owner still has to send it before the approval expires');
    expect(words).not.toContain('go ahead');
  });
  it('headlines the payout by its own status, not by the settlement’s "Ready to pay out"', () => {
    const waiting = render('owner', [approval({ status: 'pending' })]).replace(/<!-- -->/g, '');
    expect(waiting).toContain('Waiting for approval');
    // the trail no longer opens with a second, disagreeing status chip
    expect(waiting).not.toContain('Ready to pay out');
  });
});

describe('who may take a request back', () => {
  const mine = approval({ makerUserId: ME });
  const others = approval({ makerUserId: 'TEST-maker' });
  const render = (a: Approval) =>
    renderToString(
      <PayoutDetailView
        portal={portal}
        settlement={ready(settlement({ status: 'posted', settledAt: null, sentAt: null, payoutMethod: null, payoutRef: null }))}
        lifecycle={noLifecycle}
        approvals={ready([a])}
        usage={noUsage}
        halts={noHalts}
        role="owner"
        now={NOW}
        names={new Map()}
        readAt={null}
        reload={noop}
      />,
    );
  it('shows "Cancel my request" to the person who asked', () => {
    expect(render(mine)).toContain('Cancel my request');
  });
  it('shows nothing about cancelling to anyone else', () => {
    const out = render(others);
    expect(out).not.toContain('Cancel my request');
    expect(out).not.toContain('Reason for cancelling');
  });
});

describe('a failed payout says where the money is, only as far as it is known', () => {
  const failed = settlement({
    status: 'failed',
    settledAt: null,
    sentAt: '2026-10-05T09:30:00.000Z',
    failedAt: '2026-10-05T10:00:00.000Z',
    failure: { code: 'pay.rail_declined', message: 'The payment network declined this payout.' },
  });
  const lifecycle = (reversed: boolean): Resource<Lifecycle> =>
    ready({
      settlementId: failed.id,
      status: 'failed',
      events: [
        { id: 'e1', at: '2026-10-05T09:30:00.000Z', timeKnown: true, kind: 'rail.sent' },
        ...(reversed ? [{ id: 'e2', at: '2026-10-05T10:00:00.000Z', timeKnown: true, kind: 'payout.reversed' }] : []),
      ],
    });
  const render = (lc: Resource<Lifecycle>) =>
    renderToString(
      <PayoutDetailView
        portal={portal}
        settlement={ready(failed)}
        lifecycle={lc}
        approvals={ready([])}
        usage={noUsage}
        halts={noHalts}
        role="owner"
        now={NOW}
        names={new Map()}
        readAt={null}
        reload={noop}
      />,
    );
  it('claims the money is back in the balance only when the payout was reversed', () => {
    expect(render(lifecycle(true))).toContain('The money is back in your USDT balance.');
    const unknown = render(lifecycle(false));
    expect(unknown).not.toContain('The money is back');
    expect(unknown).toContain('We can’t tell from this page whether the money is back in your USDT balance.');
  });
  it('ends the trail on the refusal, with its time, when the read left the closing step out', () => {
    const out = render(lifecycle(false)).replace(/<!-- -->/g, '');
    const trail = out.slice(out.indexOf('What happened'), out.indexOf('Approval requests'));
    expect(trail.lastIndexOf('The payment network refused it')).toBeGreaterThan(trail.lastIndexOf('Sent to the payment network'));
    expect(trail).not.toContain('Time not recorded');
  });
});

describe('the tier ladder', () => {
  const caps = [{ kind: 'per_payment' as const, assetCode: 'USDT', limit: '5000' }];
  const list = (patch: Partial<Extract<TierList, { status: 'configured' }>> = {}): Resource<TierList> =>
    ready({
      status: 'configured',
      ownTierId: 'a',
      tiers: [
        { id: 'a', name: 'Standard (test)', caps, reserve: { rollingReserveBps: 500, holdDays: 7 } },
        { id: 'b', name: 'Growth (test)', caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: '25000' }], reserve: null },
      ],
      ...patch,
    });
  it('lists every tier with its limits and marks the merchant’s own', () => {
    const out = renderToString(<TierLadder tiers={list()} retry={noop} test={false} />).replace(/<!-- -->/g, '');
    expect(out).toContain('Standard (test)');
    expect(out).toContain('Growth (test)');
    expect(out).toContain('Your tier');
    expect(out).toContain('5,000');
    expect(out).toContain('25,000');
    expect(out).toContain('5.00%');
    expect(out).not.toContain('Limits not set yet');
  });
  it('says so when the account is on none of the listed tiers', () => {
    expect(renderToString(<TierLadder tiers={list({ ownTierId: null })} retry={noop} test={false} />)).toContain(
      'Your account is not on one of the listed tiers.',
    );
  });
  it('says nothing is published rather than inventing a tier', () => {
    const out = renderToString(<TierLadder tiers={ready({ status: 'not_configured', ownTierId: null })} retry={noop} test={false} />);
    expect(out).toContain('No tiers are published to compare with.');
  });
});

describe('the effective fee rate', () => {
  it('shows the service’s rate per asset: exact as is, rounded down said so, no volume said so', () => {
    const out = renderToString(
      <EffectiveRatesList
        rates={[
          { assetCode: 'USDT', fees: '3', gross: '200', rate: '0.015', rateStatus: 'exact' },
          { assetCode: 'USD', fees: '1', gross: '63', rate: '0.015873', rateStatus: 'rounded' },
          { assetCode: 'EUR', fees: '0', gross: '0', rate: null, rateStatus: 'no_volume' },
        ]}
      />,
    );
    expect(out).toContain('1.50%');
    expect(out).toContain('1.5873% (rounded down)');
    expect(out).toContain('No payments in this period');
  });
  it('falls back to what the caller shows while the service does not send rates', () => {
    const out = renderToString(<EffectiveFeeView resource={ready(null)} fallback={<p>From 1.5% + 0.30</p>} note="note" />);
    expect(out).toContain('From 1.5% + 0.30');
    expect(out).not.toContain('note');
  });
});

describe('the tier fee table (M-money-out-06)', () => {
  const caps = [
    { kind: 'per_payment' as const, assetCode: 'USDT', limit: '5000' },
    { kind: 'beneficiaries_per_day' as const, limit: 3 },
  ];
  const fee = {
    assetCode: 'USDT',
    bands: [
      { fromAmount: '0', feeBps: 250, flatFee: null },
      { fromAmount: '10000', feeBps: 150, flatFee: '0.3' },
    ],
    minFee: '0.5',
    maxFee: null,
  };
  const table = (tiers: Extract<TierList, { status: 'configured' }>['tiers'], ownTierId: string | null = 'a') =>
    renderToString(<TierFeeTable tiers={ready({ status: 'configured', ownTierId, tiers })} retry={noop} />).replace(/<!-- -->/g, '');
  const rowOf = (out: string, id: string) => {
    const start = out.indexOf(`data-testid="tier-fee-${id}"`);
    return out.slice(start, out.indexOf('</tr>', start));
  };

  it("shows a tier's own bands, minimum and published payout fee, and marks the merchant's tier", () => {
    const out = table([{ id: 'a', name: 'TEST A', caps, fees: [fee], payoutFee: { kind: 'not_charged' } }]);
    const row = rowOf(out, 'a-USDT');
    expect(row).toContain('TEST A (your tier)');
    expect(row).toContain('2.50% from 0.00 USDT · 1.50% + 0.30 USDT from 10,000.00 USDT · minimum 0.50 USDT');
    expect(row).toContain('Not charged');
    expect(row).not.toContain('Not set');
  });

  it("shows a tier's conversion spread to full-pricing roles only, and gives each asset's row its own test id", () => {
    const tiers = [
      {
        id: 'a',
        name: 'TEST A',
        caps,
        fees: [
          { ...fee, spreadBps: 40 },
          { ...fee, assetCode: 'USD' },
        ],
        payoutFee: null,
      },
    ];
    const full = renderToString(<TierFeeTable tiers={ready({ status: 'configured', ownTierId: 'a', tiers })} retry={noop} />).replace(
      /<!-- -->/g,
      '',
    );
    expect(rowOf(full, 'a-USDT')).toContain('minimum 0.50 USDT · plus 0.40% spread on a conversion');
    expect(rowOf(full, 'a-USD')).not.toContain('spread');
    expect(full.match(/data-testid="tier-fee-a-/g)).toHaveLength(2);
    const feeOnly = renderToString(
      <TierFeeTable tiers={ready({ status: 'configured', ownTierId: 'a', tiers })} retry={noop} feeOnly />,
    ).replace(/<!-- -->/g, '');
    expect(feeOnly).not.toContain('spread');
  });

  it('a single band from zero drops its "from"', () => {
    const out = table([
      { id: 'a', name: 'TEST A', caps, fees: [{ assetCode: 'USDT', bands: [{ fromAmount: '0', feeBps: 99, flatFee: null }] }] },
    ]);
    expect(rowOf(out, 'a-USDT')).toContain('>0.99%<');
  });

  it('a tier with no fee, an empty fee list or an unpublished payout fee reads "Not set" and never free', () => {
    const out = table(
      [
        { id: 'a', name: 'TEST A', caps, fees: [], payoutFee: null },
        { id: 'b', name: 'TEST B', caps },
        { id: 'c', name: 'TEST C', caps, fees: [fee], payoutFee: { kind: 'charged_later' } },
      ],
      null,
    );
    expect(rowOf(out, 'a-none').match(/Not set/g)).toHaveLength(2);
    expect(rowOf(out, 'b-none').match(/Not set/g)).toHaveLength(2);
    expect(rowOf(out, 'c-USDT').match(/Not set/g)).toHaveLength(1);
    expect(out).not.toContain('Not charged');
    expect(out).not.toContain('your tier');
    expect(out).not.toMatch(/0\.00%|Free/);
  });

  it('says no tier is published rather than inventing one, and a failed read is a refusal with a retry', () => {
    expect(renderToString(<TierFeeTable tiers={ready({ status: 'not_configured', ownTierId: null })} retry={noop} />)).toContain(
      'No tier is published for your account, so there is no tier fee to show.',
    );
    const failed = renderToString(
      <TierFeeTable tiers={{ status: 'failed', failure: { ok: false, reason: 'unreachable', message: 'down' } } as never} retry={noop} />,
    );
    expect(failed).toContain('data-testid="failure"');
  });

  it('the calculator offers the priced assets plus every asset the own tier names, so a blank tier asks the engine', () => {
    const blank = { id: 'b', name: 'TEST B', caps, fees: [], payoutFee: null };
    expect(calculatorAssets([], blank)).toEqual(['USDT']);
    expect(calculatorAssets(['USD'], { ...blank, fees: [{ ...fee, assetCode: 'EUR' }] })).toEqual(['EUR', 'USD', 'USDT']);
    expect(calculatorAssets(['USDT'], null)).toEqual(['USDT']);
    expect(calculatorAssets([], null)).toEqual([]);
  });
});
