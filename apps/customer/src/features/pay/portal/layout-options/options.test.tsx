import { renderToString } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';
import { parseLayout, layoutHref } from './layout';
import { GroupedMenu, groups } from './Navigation';
import { LayoutDashboardView, RecentPaymentsView } from './Dashboard';
import type { Snapshot } from '../schemas';
import type { DashboardData } from '../Dashboard';

vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
// TEST DATA, deliberately beyond Number.MAX_SAFE_INTEGER and with 18 fractional digits.
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

describe('development layout switch', () => {
  it('ignores every layout in a production build', () => {
    for (const layout of ['a', 'b', 'c']) expect(parseLayout(`?layout=${layout}`, false)).toBeNull();
  });
  it('keeps current layout as the default and rejects unknown values', () => {
    for (const search of ['', '?layout=d', '?layout=A']) expect(parseLayout(search, true)).toBeNull();
  });
  it('accepts exactly the three requested development layouts', () => {
    for (const layout of ['a', 'b', 'c']) expect(parseLayout(`?layout=${layout}`, true)).toBe(layout);
  });
  it('preserves money-tool parameters, filters and fragments', () => {
    expect(layoutHref('/pay/payouts?view=tools&status=pending#review', 'b')).toBe('/pay/payouts?view=tools&status=pending&layout=b#review');
  });
  it('has five groups with no duplicate destinations', () => {
    expect(groups).toHaveLength(5);
    const paths = groups.flatMap((g) => g.items.map((i) => i[0]));
    expect(new Set(paths).size).toBe(paths.length);
  });
});
for (const layout of ['a', 'b', 'c'] as const)
  describe(`option ${layout}`, () => {
    const view = (patch: Partial<Parameters<typeof LayoutDashboardView>[0]> = {}) =>
      renderToString(
        <LayoutDashboardView
          layout={layout}
          merchant={null}
          role="owner"
          data={data}
          retry={noop}
          todayDay="2026-10-16"
          activity={<p>TEST activity</p>}
          {...patch}
        />,
      );
    it('preserves exact balances without a float round trip', () => {
      expect(view()).toContain('9,007,199,254,740,993.123456789123456789');
    });
    it('links to the existing reviewed money actions, without submitting them', () => {
      const out = view();
      expect(out).toContain(`href="/pay/payouts?view=tools&amp;layout=${layout}"`);
      expect(out).toContain(`href="/pay/refunds/new?layout=${layout}"`);
      expect(out).not.toContain('<form');
    });
    it('does not offer owner money actions to teammates', () => {
      const out = view({ role: 'viewer' });
      expect(out).not.toContain('view=tools');
      expect(out).not.toContain('/pay/refunds/new');
    });
    it('does not manufacture a historical balance change or tier', () => {
      const out = view();
      expect(out).toContain('Balance change arrives with the next backend update.');
      expect(out).toContain('Tier, limit usage');
      expect(out).not.toContain('+0.00');
    });
    it('announces loading rather than showing a zero balance', () => {
      const out = view({ data: { ...data, today: { status: 'loading' } } });
      expect(out).toContain('aria-busy="true"');
      expect(out).not.toContain('9007199254740993');
    });
    it('gives an empty activity feed a useful next action', () => {
      const out = renderToString(<RecentPaymentsView layout={layout} resource={{ status: 'ready', data: [] }} retry={noop} at={null} />);
      expect(out).toContain('Your first payment starts here');
      expect(out).toContain(`/pay/links/new?layout=${layout}`);
    });
    it('keeps all grouped navigation reachable and the preview selected', () => {
      const out = renderToString(<GroupedMenu layout={layout} here="/pay/payments" />);
      expect(out).toContain('aria-current="page"');
      expect(out.match(/<details/g)).toHaveLength(5);
      expect(out).toContain(`/pay/developer?layout=${layout}`);
    });
  });
