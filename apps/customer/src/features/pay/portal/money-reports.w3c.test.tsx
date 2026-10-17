import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { MoneyView, BalanceActivity } from './Money';
import { Reports } from './Reports';
import type { ControlProfile, Snapshot } from './schemas';
import { parsePortalRoute } from './routes';
const now = new Date().toISOString();
const snapshot: Snapshot = {
  merchantId: 'TEST',
  freshness: { asOf: now, lagSeconds: 0 },
  balances: [{ assetCode: 'USDT', clearing: '0.000000000000000001', available: '9007199254740993.000000000000000001' }],
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
const control: ControlProfile = {
  merchantId: 'TEST',
  tierId: null,
  archetypeId: null,
  caps: null,
  pricing: null,
  reserve: null,
  version: 'TEST',
  updatedAt: null,
};
const ready = <T,>(data: T) => ({ status: 'ready' as const, data });
const render = (data = snapshot) => renderToString(<MoneyView snapshot={ready(data)} control={ready(control)} retry={() => {}} />);
it('keeps every balance decimal exact and never invents a reserve amount', () => {
  const out = render();
  expect(out).toContain('9,007,199,254,740,993.000000000000000001');
  expect(out).toContain('No reserve policy configured');
  expect(out).toContain('Reserved balances');
  expect(out).not.toContain('Reserved balance</span>');
});
it('shows missing history explicitly rather than substituting a payment-volume chart', () => {
  expect(render()).toContain('Payment volume is not used as a substitute for a balance chart');
  const out = renderToString(<BalanceActivity />);
  expect(out).toContain('No running balance is estimated here');
  expect(out).toContain('/pay/settlements');
});
it('shows an empty account without zero-valued balance tiles', () => {
  const out = render({ ...snapshot, balances: [] });
  expect(out).toContain('No asset balances returned');
  expect(out).not.toContain('pp-kpi-value');
});
it('flags stale snapshots and renders loading and plain-English read errors', () => {
  expect(render({ ...snapshot, freshness: { asOf: '2020-01-01T00:00:00Z', lagSeconds: 0 } })).toContain('older than expected');
  expect(renderToString(<MoneyView snapshot={{ status: 'loading' }} control={{ status: 'loading' }} retry={() => {}} />)).toContain(
    'aria-busy="true"',
  );
  const out = renderToString(
    <MoneyView
      snapshot={{
        status: 'failed',
        failure: { ok: false, reason: 'forbidden', code: 'pay.merchant_forbidden', message: 'pay.merchant_forbidden' },
      }}
      control={{ status: 'loading' }}
      retry={() => {}}
    />,
  );
  expect(out).toContain('Your account does not have access');
  expect(out).not.toContain('pay.merchant_forbidden');
});
it('offers exactly the three supported export-job kinds and names the missing report capabilities', () => {
  const out = renderToString(<Reports />);
  for (const kind of ['payments', 'settlements', 'payouts']) expect(out).toContain(`/pay/reports/exports?report=${kind}`);
  expect(out).not.toContain('?report=refunds');
  expect(out).toContain('custom columns');
  expect(out).toContain('timestamps embedded in the CSV');
});
it('routes the report-job alias and balance activity without swallowing unknown children', () => {
  expect(parsePortalRoute('/pay/money')).toEqual({ room: 'money' });
  expect(parsePortalRoute('/pay/money/activity')).toEqual({ room: 'money-activity' });
  expect(parsePortalRoute('/pay/reports')).toEqual({ room: 'reports' });
  expect(parsePortalRoute('/pay/reports/exports')).toEqual({ room: 'report-exports' });
  expect(parsePortalRoute('/pay/money/unknown')).toBeNull();
});
