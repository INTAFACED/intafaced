import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { DeveloperUnavailable, KeysView, EndpointsView, DeliveryRows } from './Developers';
import { safeEndpointUrl } from './ExtensionTools';
import { parsePortalRoute } from './routes';
import type { BusinessPayApi } from '../pay-api';
const ready = <T,>(data: T) => ({ status: 'ready' as const, data });
const noop = () => {};
const pay = { authority: { userId: 'TEST', scopes: ['pay:read'] }, guard: { status: () => null } } as unknown as BusinessPayApi;
const endpoint = {
  id: 'TEST-endpoint',
  merchantId: 'TEST',
  url: 'https://receiver.invalid/events?token=TOP-SECRET',
  status: 'active' as const,
  disabledReason: null,
  consecutiveFailures: 2,
  createdAt: '2026-10-16T00:00:00Z',
  updatedAt: '2026-10-16T01:00:00Z',
};
const delivery = {
  id: 'TEST-delivery',
  endpointId: endpoint.id,
  merchantId: 'TEST',
  eventId: 'TEST-event',
  eventType: 'payment.captured',
  status: 'failed' as const,
  attempts: 2,
  nextAttemptAt: '2026-10-16T02:00:00Z',
  lastStatusCode: 500,
  lastError: 'SECRET internal traceback',
  createdAt: '2026-10-16T01:00:00Z',
  deliveredAt: null,
};
it('routes developer pages and rejects extra segments', () => {
  for (const slug of ['keys', 'signing', 'webhooks', 'deliveries'])
    expect(parsePortalRoute(`/pay/developer/${slug}`)?.room).toBe(`developer-${slug}`);
  expect(parsePortalRoute('/pay/developer/webhooks/a%2Fb')).toEqual({ room: 'developer-endpoint', param: 'a/b' });
  expect(parsePortalRoute('/pay/developer/webhooks/a/b')).toBeNull();
  expect(parsePortalRoute('/pay/developer/keys/a')).toBeNull();
});
it('retains the company authority refusal without exposing forms or invented records', () => {
  const out = renderToString(<DeveloperUnavailable room="developer-keys" />);
  expect(out).toContain('see your API keys and webhook settings');
  expect(out).not.toContain('<input');
});
it('excludes live and non-Pay keys from metadata tables', () => {
  const out = renderToString(
    <KeysView
      resource={ready([
        {
          id: '1',
          name: 'TEST Sandbox',
          prefix: 'test_',
          scopes: ['pay:read'],
          lastUsedAt: null,
          revoked: false,
          mode: 'sandbox' as const,
        },
        {
          id: '2',
          name: 'LIVE KEY DO NOT DISPLAY',
          prefix: 'live_',
          scopes: ['pay:read'],
          lastUsedAt: null,
          revoked: false,
          mode: 'live' as const,
        },
        {
          id: '3',
          name: 'UNRELATED KEY',
          prefix: 'other_',
          scopes: ['trade:read'],
          lastUsedAt: null,
          revoked: false,
          mode: 'sandbox' as const,
        },
      ])}
      pay={pay}
      reload={noop}
    />,
  );
  expect(out).toContain('TEST Sandbox');
  expect(out).not.toContain('LIVE KEY DO NOT DISPLAY');
  expect(out).not.toContain('UNRELATED KEY');
  expect(out).toContain('1 records shown');
  expect(out).toContain('manage how your business connects');
});
it('redacts URL credentials and never renders raw delivery errors', () => {
  expect(safeEndpointUrl('https://user:secret@receiver.invalid/hook?token=secret#secret')).toBe('https://receiver.invalid/hook?…');
  const out = renderToString(<DeliveryRows resource={ready([delivery])} reload={noop} />);
  expect(out).toContain('500');
  expect(out).toContain('Failed');
  expect(out).not.toContain('SECRET');
  expect(out).toContain('2');
});
it('shows endpoint facts and returned times without fabricating success or latency', () => {
  const out = renderToString(
    <EndpointsView
      resource={ready([endpoint])}
      deliveries={ready([delivery])}
      pay={{ ...pay, access: () => null }}
      endpointId={endpoint.id}
      reload={noop}
    />,
  );
  expect(out).toContain('TEST-endpoint');
  expect(out).toContain('Webhook deliveries');
  expect(out).toContain('2026-10-16');
  expect(out).not.toContain('TOP-SECRET');
  expect(out).not.toContain('SECRET internal');
  expect(out).toContain('choose where payment updates are sent');
});
it('renders the same unavailable window for any unreturned endpoint id', () => {
  const render = (id: string) =>
    renderToString(<EndpointsView resource={ready([endpoint])} deliveries={ready([])} pay={pay} endpointId={id} reload={noop} />);
  expect(render('foreign')).toBe(render('missing'));
});
it('supports loading and error states without treating failure as zero', () => {
  expect(renderToString(<DeliveryRows resource={{ status: 'loading' }} reload={noop} />)).toContain('aria-busy="true"');
  const out = renderToString(
    <DeliveryRows
      resource={{ status: 'failed', failure: { ok: false, reason: 'unreachable', message: 'raw_error', status: 503 } }}
      reload={noop}
    />,
  );
  expect(out).toContain('Try again');
  expect(out).not.toContain('raw_error');
});
