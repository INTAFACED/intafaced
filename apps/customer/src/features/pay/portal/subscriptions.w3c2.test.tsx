import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { CreateSubscriptionView, SubscriptionDetailView, SubscriptionsView } from './Subscriptions';
import { createApiClient } from '../../../shared/api';
import { createPortalApi } from './api';
import { parsePortalRoute } from './routes';
const M = '11111111-1111-4111-8111-111111111111';
const S = '66666666-6666-4666-8666-666666666666';
const D = '77777777-7777-4777-8777-777777777777';
const at = '2026-10-16T00:00:00Z';
const subscription = {
  id: S,
  merchantId: M,
  mandateId: D,
  customerId: 'TEST-customer',
  nextRunAt: at,
  status: 'active' as const,
  cancelledAt: null,
  path: 'crypto_invoice',
  createdAt: at,
  anchorAt: null,
  anchorOccurrence: 0,
  pausedAt: null,
  resumedAt: null,
  stalledAt: null,
  stallReason: null,
};
const mandate = {
  id: D,
  merchantId: M,
  customerId: 'TEST-customer',
  assetId: 'USDT',
  amount: '9007199254740993.000000000000000001',
  ceiling: null,
  cadence: 'monthly' as const,
  startsAt: at,
  endsAt: null,
  railAdapter: null,
  railMandateRef: null,
  status: 'active' as const,
  cancelledAt: null,
  createdAt: at,
};
const ready = <T,>(data: T) => ({ status: 'ready' as const, data });
const noop = () => {};
it('registers list, detail and creation routes', () => {
  expect(parsePortalRoute('/pay/subscriptions')).toEqual({ room: 'subscriptions' });
  expect(parsePortalRoute('/pay/subscriptions/new')).toEqual({ room: 'subscription-new' });
  expect(parsePortalRoute(`/pay/subscriptions/${S}`)).toEqual({ room: 'subscription', param: S });
});
it('shows only recorded schedule metrics without estimating recurring revenue', () => {
  const out = renderToString(<SubscriptionsView resource={ready([subscription])} reload={noop} limit={50} setLimit={noop} />);
  expect(out).toContain(`/pay/subscriptions/${S}`);
  expect(out).toContain('TEST-customer');
  expect(out).toContain('No monthly recurring revenue');
  expect(out).toContain('1 records shown');
});
it('renders an empty state and a loading skeleton', () => {
  expect(renderToString(<SubscriptionsView resource={ready([])} reload={noop} limit={50} setLimit={noop} />)).toContain(
    'No subscriptions in this view',
  );
  expect(renderToString(<SubscriptionsView resource={{ status: 'loading' }} reload={noop} limit={50} setLimit={noop} />)).toContain(
    'aria-busy="true"',
  );
});
it('keeps money exact and separates invoice creation from payment', () => {
  const out = renderToString(
    <SubscriptionDetailView
      subscription={subscription}
      mandate={ready(mandate)}
      cycles={ready({
        subscriptionId: S,
        cycles: [
          {
            occurrence: 1,
            amount: mandate.amount,
            status: 'invoiced',
            idempotencyKey: 'TEST-period-key',
            attemptCount: 2,
            rejectionCode: null,
            paymentId: null,
            exhausted: false,
            settledAt: null,
            notifyStatus: 'skipped_unwired',
            notifyCode: 'INTERNAL DO NOT DISPLAY',
          },
        ],
      })}
      executions={ready([])}
      pay={null}
      reload={noop}
    />,
  );
  expect(out).toContain('9,007,199,254,740,993.000000000000000001');
  expect(out).toContain('USDT');
  expect(out).toContain('not proof of payment');
  expect(out).toContain('TEST-period-key');
  expect(out).toContain('No payment created');
  expect(out).not.toContain('INTERNAL DO NOT DISPLAY');
  expect(out).not.toContain('>Cancel subscription<');
  expect(out).toContain('No subscription has been changed');
});
it('creation never offers refused card paths or fabricates customer authorization', () => {
  const out = renderToString(
    <CreateSubscriptionView
      mandates={ready([mandate])}
      posture={ready({
        paths: [
          { path: 'crypto_invoice', charge: 'open_crypto_invoice', opensMoney: true, posture: 'invoice-and-watch' },
          { path: 'card', charge: 'refuse', opensMoney: false, posture: 'refuse' },
        ],
        preChargeNotify: { status: 'unwired', notified: false, merchantReadable: 'none' },
        card: { status: 'refuse_closed', code: 'pay.mandate_rail_absent' },
      })}
      pay={null}
      reload={noop}
    />,
  );
  expect(out).toContain('value="crypto_invoice"');
  expect(out).not.toContain('value="card"');
  expect(out).toContain('does not obtain customer consent');
  expect(out).not.toContain('>Confirm<');
});
it('validates merchant ownership on schedule list and detail responses', async () => {
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    calls.push(url);
    return new Response(
      JSON.stringify({
        result: {
          data: url.includes('subscription.list')
            ? [{ ...subscription, merchantId: 'foreign' }]
            : { ...subscription, merchantId: 'foreign' },
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const portal = createPortalApi(createApiClient({ fetch: fetcher }), 'TEST-user');
  expect((await portal.subscriptions(M, 25)).ok).toBe(false);
  expect((await portal.subscription(M, S)).ok).toBe(false);
  expect(calls[0]).toContain('subscription.list');
  const input = JSON.parse(new URL(calls[0]!, 'https://example.invalid').searchParams.get('input')!);
  expect(input).toEqual({ merchantId: M, limit: 25 });
});
it('uses only existing cycle and execution reads with explicit bounded limits', async () => {
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    calls.push(url);
    return new Response(
      JSON.stringify({ result: { data: url.includes('subscription.cycles') ? { subscriptionId: S, cycles: [] } : [] } }),
      { status: 200 },
    );
  }) as typeof fetch;
  const portal = createPortalApi(createApiClient({ fetch: fetcher }), 'TEST-user');
  expect((await portal.subscriptionCycles(S)).ok).toBe(true);
  expect((await portal.subscriptionExecutions(S)).ok).toBe(true);
  for (const url of calls)
    expect(JSON.parse(new URL(url, 'https://example.invalid').searchParams.get('input')!)).toEqual({ subscriptionId: S, limit: 200 });
});
