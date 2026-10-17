import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { useListFilters } from '../ui/FilterRow';
import type { ListState } from '../hooks';
import { CreateSubscriptionView, SubscriptionDetailView, SubscriptionsView, SubscriptionTerms } from './Subscriptions';
import { createApiClient } from '../../../../shared/api';
import { createPortalApi } from '../api';
import { parsePortalRoute } from '../routes';
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
function Harness(props: {
  list: ListState<typeof subscription>;
  mandateId?: string;
  mandates?: ReturnType<typeof ready<(typeof mandate)[]>>;
}) {
  const filters = useListFilters();
  return (
    <SubscriptionsView
      list={props.list}
      {...(props.mandates ? { mandates: props.mandates } : {})}
      filters={filters}
      {...(props.mandateId ? { mandateId: props.mandateId } : {})}
      loadMore={noop}
      reload={noop}
    />
  );
}
const listOf = <T,>(items: T[], hasMore = false): ListState<T> => ({ status: 'ready', items, hasMore, more: 'idle' });
it('lists recorded schedules with server filters and no estimated revenue or placeholder card', () => {
  const out = renderToString(<Harness list={listOf([subscription])} />);
  expect(out).toContain(`/pay/subscriptions/${S}`);
  expect(out).toContain('TEST-customer');
  expect(out).not.toContain('recurring revenue and subscription trends');
  expect(out).toContain('1 shown');
  expect(out).toContain('Active');
});
it('shows each subscription\u2019s amount and cadence from its mandate, and says so when the mandate is not shown', () => {
  const withTerms = renderToString(<Harness list={listOf([subscription])} mandates={ready([mandate])} />);
  expect(withTerms).toContain('Amount per cycle');
  expect(withTerms).toContain('Billing cadence');
  expect(withTerms).toContain('9,007,199,254,740,993.00');
  expect(withTerms).toContain('Monthly');
  expect(withTerms).toContain('Crypto invoice and watch');
  expect(withTerms).not.toContain('crypto_invoice');
  const without = renderToString(
    <Harness list={listOf([{ ...subscription, mandateId: 'TEST-unknown-mandate' }])} mandates={ready([mandate])} />,
  );
  expect(without).toContain('Not shown');
});
it('says no charge attempts yet (not no billing cycles) when cycles exist but no attempts do', () => {
  const out = renderToString(
    <SubscriptionDetailView
      subscription={subscription}
      mandate={ready(mandate)}
      cycles={ready({
        subscriptionId: S,
        cycles: [
          {
            occurrence: 1,
            amount: '19.00',
            status: 'settled',
            idempotencyKey: null,
            attemptCount: 1,
            rejectionCode: null,
            paymentId: null,
            exhausted: false,
            settledAt: null,
            notifyStatus: null,
            notifyCode: null,
          },
        ],
      })}
      executions={ready([])}
      pay={null}
      reload={noop}
    />,
  );
  expect(out).not.toContain('No billing cycles recorded yet');
  expect(out).toContain('No charge attempts yet');
  expect(out).toContain('1 billing cycle shown');
});
it('renders an empty state and a loading skeleton', () => {
  expect(renderToString(<Harness list={listOf([])} />)).toContain('No subscriptions in this view');
  expect(renderToString(<Harness list={{ status: 'loading' }} />)).toContain('aria-busy="true"');
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
  expect(out).toContain('9,007,199,254,740,993.00');
  expect(out).toContain('USDT');
  expect(out).toContain('not proof of payment');
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
            ? { items: [{ ...subscription, merchantId: 'foreign' }], nextCursor: null }
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

it('uses the same complete mandate summary for selection and confirmation, including finite dates and ceiling', () => {
  const endsAt = '2027-10-16T00:00:00Z';
  const out = renderToString(
    <SubscriptionTerms mandate={{ ...mandate, endsAt, ceiling: '10000000000000000.000000000000000001' }} path="crypto_invoice" />,
  );
  for (const value of [
    mandate.customerId,
    D,
    'Crypto invoice and watch',
    'USDT',
    'Monthly',
    'Billing cadence',
    'Authorization starts',
    'Authorization ends',
    'Authorization ceiling',
    '10,000,000,000,000,000.00',
  ])
    expect(out).toContain(value);
  expect(out).toContain(`dateTime="${at}"`);
  expect(out).toContain(`dateTime="${endsAt}"`);
  const open = renderToString(<SubscriptionTerms mandate={mandate} path="crypto_invoice" />);
  expect(open).toContain('Open ended');
  expect(open).toContain('No limit set');
  expect(open).not.toContain('No ceiling returned');
});

it('prefills and locks the original charge path after reload and links to that mandate subscriptions', async () => {
  const { createPayMutationGuard } = await import('../../pay-api');
  const values = new Map<string, string>();
  const key = `TEST-user:subscription-create:${D}`;
  values.set(`pay.unresolved:${key}`, JSON.stringify({ status: 'uncertain', reference: 'TEST-original-attempt', path: 'crypto_invoice' }));
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const pay = {
    authority: { userId: 'TEST-user' },
    guard: createPayMutationGuard(storage),
    access: () => null,
  } as unknown as import('../../pay-api').BusinessPayApi;
  vi.stubGlobal('location', { search: `?mandateId=${D}` });
  try {
    const out = renderToString(
      <CreateSubscriptionView
        mandates={ready([mandate])}
        posture={ready({
          paths: [{ path: 'crypto_invoice', charge: 'open_crypto_invoice', opensMoney: true, posture: 'invoice-and-watch' }],
          preChargeNotify: { status: 'unwired', notified: false, merchantReadable: 'none' },
          card: { status: 'refuse_closed', code: 'pay.mandate_rail_absent' },
        })}
        pay={pay}
        reload={noop}
      />,
    );
    expect(out).toMatch(/<select disabled=""><option[^>]*value=""[^>]*>[^<]*<\/option><option[^>]*value="crypto_invoice" selected=""/);
    expect(out).toContain(`/pay/subscriptions?mandateId=${D}`);
    expect(out).toContain('TEST-customer');
    expect(pay.guard.reference(key)).toBe('TEST-original-attempt');
  } finally {
    vi.unstubAllGlobals();
  }
});

it('filters the subscriptions link to its mandate', () => {
  vi.stubGlobal('location', { search: `?mandateId=${D}` });
  try {
    const out = renderToString(
      <Harness
        list={listOf([
          subscription,
          { ...subscription, id: 'TEST-other-subscription', mandateId: 'TEST-other-mandate', customerId: 'TEST-other-customer' },
        ])}
        mandateId={D}
      />,
    );
    expect(out).toContain('TEST-customer');
    expect(out).not.toContain('TEST-other-customer');
  } finally {
    vi.unstubAllGlobals();
  }
});
