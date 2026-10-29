import { renderToString } from 'react-dom/server';
import { beforeAll, expect, it, vi } from 'vitest';
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('@intafaced/ui', async (original) => {
  const real = await original<typeof import('@intafaced/ui')>();
  return { ...real, useToast: () => ({ add: () => {} }) };
});
const USER = '00000000-0000-4000-8000-000000000001';
vi.mock('../../features/session/session', () => ({
  useSession: () => ({
    userId: USER,
    session: { accessToken: 'x', expiresAt: '2099-01-01T00:00:00Z', userId: USER },
    api: { canWrite: () => true, query: () => new Promise(() => {}), mutate: () => new Promise(() => {}) },
    profiles: { status: 'ready', businesses: [], active: 'personal', business: null, notice: null, reload: () => {} },
  }),
}));
import { BillsCard } from './BillsCard';
import { GlobalCard } from './GlobalCard';
import { ReceiveCard } from './ReceiveCard';
import { RequestCard } from './RequestCard';
import { receivableAssets } from './RequestCard';
import { tabOf } from './index';

beforeAll(() => {
  Object.defineProperty(globalThis, 'location', {
    value: { origin: 'https://app.test', pathname: '/pay/receive', search: '' },
    configurable: true,
  });
});

it('shows every bill step with the controls off and the reason on screen', () => {
  const out = renderToString(<BillsCard />);
  expect(out).toContain('Bill pay isn’t connected');
  for (const step of ['Choose a biller', 'Enter the bill reference', 'Enter the amount', 'Review and pay', 'Follow the status'])
    expect(out).toContain(step);
  expect(out).toContain('<fieldset class="pay-fieldset" disabled');
  expect(out).toMatch(/<button[^>]*disabled[^>]*data-testid="bills-review"|<button[^>]*data-testid="bills-review"[^>]*disabled/);
  expect(out).toContain('No bills paid yet.');
  expect(out).not.toMatch(/coming soon/i);
});

it('shows no rate, fee or arrival abroad until the service gives a quote, and sends nothing before then', () => {
  const out = renderToString(<GlobalCard />);
  expect(out).toContain('No rate. A rate appears here only when a live source is connected.');
  const quote = out.slice(out.indexOf('data-testid="global-quote"'), out.indexOf('</dl>', out.indexOf('data-testid="global-quote"')));
  expect(quote.match(/<dd>—<\/dd>/g)).toHaveLength(4);
  expect(out).toMatch(/<button[^>]*disabled[^>]*data-testid="global-review"|<button[^>]*data-testid="global-review"[^>]*disabled/);
  expect(out).toMatch(/<button[^>]*disabled[^>]*data-testid="global-get-quote"|<button[^>]*data-testid="global-get-quote"[^>]*disabled/);
  expect(out).not.toContain('data-testid="global-confirm"');
});

it('shows a QR code and a payment link for the customer’s handle', () => {
  const out = renderToString(<ReceiveCard identity={{ status: 'handles', handle: 'maya_test' }} />);
  expect(out).toContain('@maya_test');
  expect(out).toContain('data-testid="pay-qr"');
  expect(out).toContain('https://app.test/pay/send?to=maya_test');
});

it('shows the handle change and the find-me switch, the switch off and disabled until the settings load', () => {
  const out = renderToString(<ReceiveCard identity={{ status: 'handles', handle: 'maya_test' }} />);
  expect(out).toContain('data-testid="handle-settings"');
  expect(out).toContain('Let people find me by my handle');
  expect(out).toMatch(/role="switch"[^>]*aria-checked="false"|aria-checked="false"[^>]*role="switch"/);
  expect(out).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*Change handle/);
});

it('uses the Account ID in the link when the server has no handles', () => {
  const out = renderToString(<ReceiveCard identity={{ status: 'accountId' }} />);
  expect(out).toContain(`https://app.test/pay/send?to=${USER}`);
});

it('shows loading, not an empty form, while it reads the customer’s balances', () => {
  const out = renderToString(<RequestCard identity={{ status: 'handles', handle: 'maya_test' }} />);
  expect(out).toContain('data-testid="request-loading"');
  expect(out).not.toContain('data-testid="request-create"');
});

it('lets a customer request only assets they have a main space for, dollar coins first', () => {
  expect(
    receivableAssets([
      { assetId: 'ETH', kind: 'primary' },
      { assetId: 'USDT', kind: 'primary' },
      { assetId: 'BTC', kind: 'named' },
      { assetId: 'ETH', kind: 'primary' },
      { assetId: 'BTC', kind: 'primary' },
    ]),
  ).toEqual(['USDT', 'BTC', 'ETH']);
  expect(receivableAssets([])).toEqual([]);
});

it('opens the right tab for each address', () => {
  expect(tabOf('/pay')).toBe('send');
  expect(tabOf('/pay/send?to=maya_test')).toBe('send');
  expect(tabOf('/pay/receive')).toBe('receive');
  expect(tabOf('/pay/request/')).toBe('request');
  expect(tabOf('/pay/bills')).toBe('bills');
  expect(tabOf('/pay/global')).toBe('global');
});
