import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { findRoom } from '../../../../app/navigation';
import { Invoices } from './Invoices';
import { parsePortalRoute } from '../routes';
import { notLiveWords } from '../ui/test-words';
it('routes invoice references separately from the list', () => {
  expect(parsePortalRoute('/pay/invoices')).toEqual({ room: 'invoices' });
  expect(parsePortalRoute('/pay/invoices/a%2Fb')).toEqual({ room: 'invoice', param: 'a/b' });
});
it('does not invent balances or an invoice write path', () => {
  const out = renderToString(<Invoices />);
  expect(out).toMatch(notLiveWords);
  expect(out).toContain('href="/pay/subscriptions"');
  expect(out).not.toContain('<button');
  expect(out).not.toMatch(/\$0|0\.00|<input/);
});
it('does not confirm the existence of an unreadable invoice', () => {
  const out = renderToString(<Invoices invoiceId="TEST-foreign-reference" />);
  expect(out).toContain('does not confirm whether the reference exists');
  expect(out).not.toContain('Paid');
});

it('registers detail routes in the application shell as merchant-only rooms', () => {
  for (const route of [
    '/pay/invoices/TEST',
    '/pay/developer/webhooks/TEST',
    '/pay/subscriptions/TEST',
    '/pay/conversion/TEST',
    '/pay/settings/profile',
  ]) {
    expect(findRoom(route)?.area).toBe('pay');
    expect(findRoom(route)?.business).toBe(true);
  }
});
