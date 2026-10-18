import { renderToString } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';
import { LayoutDashboardView, RecentPaymentsView } from './DashboardHome';
import { usagePercent } from './TierUsage';
import { type Snapshot } from '../schemas';
import type { DashboardData } from './Dashboard';
import { withMoneyAccess } from '../access/money-test-kit';
vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
// TEST DATA beyond the safe integer range, with 18 decimal places.
const snapshot: Snapshot = {
  merchantId: 'TEST',
  freshness: { asOf: '2026-10-16T00:00:00Z', lagSeconds: 2 },
  balances: [{ assetCode: 'USDT', available: '9007199254740993.123456789123456789', clearing: '1.5' }],
  paymentCount: 0,
  statusMix: [],
  captured: [],
  refunded: [],
  net: [],
  settlements: [],
  averagePayment: [],
  largestPayment: [],
  linkUsage: { linksUsed: 0, paymentsViaLinks: 0 },
  feeRevenue: [],
  conversionVolume: null,
};
const ready = { status: 'ready', data: snapshot } as const;
const data: DashboardData = {
  today: ready,
  rolling_7d: ready,
  rolling_30d: ready,
  series: { status: 'ready', data: { merchantId: 'TEST', freshness: snapshot.freshness, points: [] } },
};
const noop = () => undefined;
const view = (patch: Partial<Parameters<typeof LayoutDashboardView>[0]> = {}, held = true) =>
  renderToString(
    withMoneyAccess(
      <LayoutDashboardView
        merchant={null}
        role="owner"
        data={data}
        retry={noop}
        todayDay="2026-10-16"
        activity={<p>TEST activity</p>}
        {...patch}
      />,
      held,
    ),
  );
describe('portal overview', () => {
  it('uses ordinary routes for existing reviewed money actions', () => {
    expect(view()).toContain('href="/pay/payouts?view=tools"');
    expect(view()).toContain('href="/pay/refunds/new"');
    expect(view()).not.toContain('<form');
    expect(view()).not.toContain('layout=');
  });
  it('switches Pay out and Refund off, with the reason, when the person cannot begin a payout or a refund', () => {
    const out = view({}, false);
    expect(out).not.toContain('href="/pay/payouts?view=tools"');
    expect(out).not.toContain('href="/pay/refunds/new"');
    expect(out).toContain('Only the account owner can refund payments.');
    expect(out).toContain('Only the account owner can send payouts.');
    // Making a link is an ordinary write and stays on.
    expect(out).toContain('href="/pay/links/new"');
  });
  it('names the UTC day beside the Today tiles', () => {
    expect(view()).toContain('Today (UTC): Oct 16, 2026');
  });
  it('gives every tile its period and the filter of the list it opens', () => {
    const out = view();
    expect(out).toContain('href="/pay/payments?date=today"');
    expect(out).toContain('href="/pay/payments?date=today"');
    expect(out).toContain('href="/pay/refunds?from=');
    expect(out).toContain('href="/pay/money"');
    expect(out).toContain('Captured<!-- --> · <!-- -->Today');
  });
  it('does not offer owner money actions to teammates', () => {
    const out = view({ role: 'viewer' });
    expect(out).not.toContain('view=tools');
    expect(out).not.toContain('/pay/refunds/new');
  });
  it('renders one selected headline balance and offers an asset selector', () => {
    const multi = { ...snapshot, balances: [...snapshot.balances, { assetCode: 'USD', available: '25', clearing: '0' }] };
    const out = view({ data: { ...data, today: { status: 'ready', data: multi } } });
    expect(out.match(/plo-number/g)).toHaveLength(1);
    expect(out).toContain('Balance asset');
    expect(out).toContain('9,007,199,254,740,993.12');
    expect(out).not.toContain('123456789123456789');
  });
  it('preserves backend gaps, loading and empty activity states', () => {
    expect(view()).not.toContain('backend update');
    expect(view({ tier: <p>TEST tier</p> })).toContain('TEST tier');
    expect(view({ data: { ...data, today: { status: 'loading' } } })).toContain('aria-busy="true"');
    const out = renderToString(<RecentPaymentsView resource={{ status: 'ready', data: [] }} retry={noop} at={null} />);
    expect(out).toContain('Your first payment starts here');
    expect(out).toContain('href="/pay/links/new"');
  });
});

describe('limit usage', () => {
  it('works the share used out exactly, and shows no bar without a figure', () => {
    expect(usagePercent('250', '1000')).toBe(25);
    expect(usagePercent('1000.5', '1000')).toBe(100);
    expect(usagePercent('0', '1000')).toBe(0);
    expect(usagePercent(null, '1000')).toBeNull();
    expect(usagePercent('5', '0')).toBeNull();
  });
});
