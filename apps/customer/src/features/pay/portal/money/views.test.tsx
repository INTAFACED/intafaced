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
import { ApprovalDecision } from './Approvals';
import { MoneyFailure, NamedBlocker } from './common';
import { ConversionChip } from './Conversion';
import { PayoutDetailView } from './Payouts';
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
    expect(out).toContain('Destination not shown for this request');
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
    expect(renderToString(<RefundChip status="posted" />)).toContain('Pending');
    expect(renderToString(<RefundChip status="reversed" />)).toContain('Failed');
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
