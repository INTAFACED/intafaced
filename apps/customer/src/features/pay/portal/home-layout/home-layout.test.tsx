import { renderToString } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';
import { groups } from './groups';
import { activeGroup, currentItem, LayoutNavigation } from './Navigation';
import { LayoutFrame } from './Frame';
import { ExactMoneyContext, MoneyDisplay, paymentLabel, portalAmount } from '../presentation';
import { paymentSchema } from '../schemas';
vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
describe('permanent Home-style portal', () => {
  it('has five tabs, at most seven items under each, and no destination twice', () => {
    expect(groups).toHaveLength(5);
    expect(groups.map((g) => g.label)).toEqual(['overview', 'payments', 'moneyOut', 'billing', 'settings']);
    for (const group of groups) expect(group.items.length).toBeLessThanOrEqual(7);
    const paths = groups.flatMap((g) => g.items.map((i) => i[0]));
    expect(new Set(paths).size).toBe(paths.length);
  });
  it('renders only the active secondary row, and hides platform-only pages outside a platform', () => {
    for (const group of groups)
      for (const [path] of group.items) {
        expect(activeGroup(path)).toBe(group);
        const out = renderToString(<LayoutNavigation here={path} />);
        for (const [href, , options] of group.items) {
          if (options?.when) expect(out, href).not.toContain(`href="${href}"`);
          else expect(out, href).toContain(`href="${href}"`);
        }
        expect(out).not.toContain('layout=');
        expect(out).not.toContain('<details');
      }
  });
  it('keeps Developers under Settings, with its pages lit as one item', () => {
    const settings = groups.find((g) => g.label === 'settings')!;
    expect(settings.items.map((i) => i[1])).toContain('developers');
    for (const path of ['/pay/developer/keys', '/pay/developer/webhooks/TEST', '/pay/developer/docs'])
      expect(currentItem(path)?.item[1], path).toBe('developers');
    expect(activeGroup('/pay/developer/sandbox')).toBe(settings);
  });
  it('lights the longest matching item: Destinations is not Payouts', () => {
    expect(currentItem('/pay/payouts/destinations')?.item[1]).toBe('destinations');
    expect(currentItem('/pay/payouts/bb1')?.item[1]).toBe('payouts');
    expect(currentItem('/pay/settings/security')?.item[1]).toBe('security');
    expect(currentItem('/pay/analytics/fees')?.item[1]).toBe('fees');
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
});
describe('asset display precision', () => {
  it.each(['USD', 'USDT'])('formats %s through bigint with carry and no Number round trip', (asset) => {
    expect(portalAmount('9007199254740993.123456789123456789', asset)).toBe('9,007,199,254,740,993.12');
    expect(portalAmount('999.999', asset)).toBe('1,000.00');
    expect(portalAmount('0', asset)).toBe('0.00');
    // One formatter (ui/format.ts): a non-zero amount below one cent keeps its digits, it is never shown as zero.
    expect(portalAmount('0.000000000000000001', asset)).toBe('0.000000000000000001');
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
