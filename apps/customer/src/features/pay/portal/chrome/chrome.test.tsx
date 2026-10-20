import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { renderToStaticMarkup } from 'react-dom/server';
import { NotLiveCard } from './NotLiveCard';
import { reason } from './copy';
import { currentHref, isMerchantArea } from './model';

describe('portal chrome', () => {
  it('tells portal pages from the rest of the app', () => {
    expect(isMerchantArea('/pay/payments/abc')).toBe(true);
    // Without a token this is the merchant's checkout settings; a payer's link carries one (see chrome/model.ts).
    expect(isMerchantArea('/pay/checkout')).toBe(true);
    expect(isMerchantArea('/pay/send')).toBe(false);
    // The personal addresses beyond the five tabs keep the personal frame (PP-order-02).
    for (const path of [
      '/pay/contacts',
      '/pay/scan',
      '/pay/history/tr_1',
      '/pay/request/rq_1',
      '/pay/cases/c1',
      '/pay/send/limits',
      '/pay/bills/invoices/i1',
      '/pay/contacts?x=1',
    ])
      expect(isMerchantArea(path), path).toBe(false);
    expect(isMerchantArea('/pay/limits')).toBe(true);
    expect(isMerchantArea('/pay/invoices/i1')).toBe(true);
    expect(isMerchantArea('/pay/anything-else')).toBe(true);
    expect(isMerchantArea('/home')).toBe(false);
  });
  it('marks exactly one menu item current', () => {
    expect(currentHref('/pay/payments/abc')).toBe('/pay/payments');
    expect(currentHref('/pay/merchant')).toBe('/pay/merchant');
    expect(currentHref('/home')).toBeUndefined();
  });
});

describe('NotLiveCard', () => {
  it('names what it is waiting for first, then what the feature will do, in plain words', () => {
    const html = renderToStaticMarkup(<NotLiveCard reason={reason('reasonFees')}>You’ll be able to send invoices.</NotLiveCard>);
    expect(html).toContain('Pricing is not set for this account: INTAFACED sets merchant fees');
    expect(html).toContain('You’ll be able to send invoices.');
    expect(html.indexOf('Pricing is not set for this account')).toBeLessThan(html.indexOf('send invoices'));
    expect(html).not.toMatch(/coming soon|backend|Arrives|\(W\d\)/i);
  });
});
