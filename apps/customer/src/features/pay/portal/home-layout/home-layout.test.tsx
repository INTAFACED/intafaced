import { renderToString } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';
import { activeGroup, groups, LayoutNavigation } from './Navigation';
import { LayoutFrame } from './Frame';
import { LayoutDashboardView, RecentPaymentsView } from './Dashboard';
import { ExactMoneyContext, MoneyDisplay, paymentLabel, portalAmount } from '../presentation';
import { paymentSchema, type Snapshot } from '../schemas';
import type { DashboardData } from '../Dashboard';

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
const view = (patch: Partial<Parameters<typeof LayoutDashboardView>[0]> = {}) =>
  renderToString(
    <LayoutDashboardView
      merchant={null}
      role="owner"
      data={data}
      retry={noop}
      todayDay="2026-10-16"
      activity={<p>TEST activity</p>}
      {...patch}
    />,
  );

describe('permanent Home-style portal', () => {
  it('has five groups with unique destinations and renders only the active secondary row', () => {
    expect(groups).toHaveLength(5);
    const paths = groups.flatMap((g) => g.items.map((i) => i[0]));
    expect(new Set(paths).size).toBe(paths.length);
    for (const group of groups)
      for (const [path] of group.items) {
        expect(activeGroup(path)).toBe(group);
        const out = renderToString(<LayoutNavigation here={path} />);
        for (const [href] of group.items) expect(out).toContain(`href="${href}"`);
        expect(out).not.toContain('layout=');
        expect(out).not.toContain('<details');
      }
  });
  it.each(['/pay/payments/TEST', '/pay/refunds/new', '/pay/developer/webhooks/TEST', '/pay/settings/notifications', '/pay/money/activity'])(
    'keeps details in their parent group: %s',
    (path) => {
      expect(activeGroup(path)).not.toBe(groups[0]);
    },
  );
  it('does not duplicate the Overview label below the group tab', () => {
    const out = renderToString(
      <LayoutFrame here="/pay/merchant" title="Overview">
        <p>TEST content</p>
      </LayoutFrame>,
    );
    expect(out.match(/>Overview</g)).toHaveLength(1);
    expect(out).toContain('Summary');
    expect(out).toContain('TEST content');
  });
  it('uses ordinary routes for existing reviewed money actions', () => {
    expect(view()).toContain('href="/pay/payouts?view=tools"');
    expect(view()).toContain('href="/pay/refunds/new"');
    expect(view()).not.toContain('<form');
    expect(view()).not.toContain('layout=');
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
    expect(view()).toContain('Balance change arrives with the next backend update.');
    expect(view()).toContain('Tier, limit usage');
    expect(view({ data: { ...data, today: { status: 'loading' } } })).toContain('aria-busy="true"');
    const out = renderToString(<RecentPaymentsView resource={{ status: 'ready', data: [] }} retry={noop} at={null} />);
    expect(out).toContain('Your first payment starts here');
    expect(out).toContain('href="/pay/links/new"');
  });
});
describe('asset display precision', () => {
  it.each(['USD', 'USDT'])('formats %s through bigint with carry and no Number round trip', (asset) => {
    expect(portalAmount('9007199254740993.123456789123456789', asset)).toBe('9,007,199,254,740,993.12');
    expect(portalAmount('999.999', asset)).toBe('1,000.00');
    expect(portalAmount('0', asset)).toBe('0.00');
    expect(portalAmount('0.000000000000000001', asset)).toBe('<0.01');
  });
  it('offers exact precision only in detail/statement context', () => {
    const money = <MoneyDisplay value="1.123456789" asset="USDT" />;
    expect(renderToString(money)).not.toContain('Show exact');
    const out = renderToString(<ExactMoneyContext.Provider value>{money}</ExactMoneyContext.Provider>);
    expect(out).toContain('Show exact');
    expect(out).toContain('1.12');
    expect(out).not.toContain('1.123456789');
  });
});
describe('payment row names', () => {
  const base = { id: 'aa000001-0000-4000-8000-000000000001' };
  it('uses supplied customer, then description, then a short human reference', () => {
    expect(paymentLabel({ ...base, customerRef: 'TEST customer', description: 'TEST order' })).toBe('TEST customer');
    expect(paymentLabel({ ...base, customerRef: ' ', description: 'TEST order' })).toBe('TEST order');
    expect(paymentLabel(base)).toBe('Payment · aa000001');
  });
  it('retains optional labels from existing payment responses', () => {
    const row = paymentSchema.parse({
      ...base,
      merchantId: base.id,
      profileId: null,
      amount: '2',
      assetId: 'USD',
      method: 'TEST',
      railAdapter: 'TEST',
      railRef: null,
      status: 'captured',
      capturedAmount: '2',
      refundedAmount: '0',
      createdAt: '2026-10-16T00:00:00Z',
      customerRef: 'TEST customer',
      description: 'TEST order',
    });
    expect(row.customerRef).toBe('TEST customer');
    expect(row.description).toBe('TEST order');
  });
});
