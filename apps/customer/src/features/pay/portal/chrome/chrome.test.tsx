import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { renderToStaticMarkup } from 'react-dom/server';
import { ComingSoonCard } from './ComingSoonCard';
import { currentHref, isMerchantArea } from './model';

describe('portal chrome', () => {
  it('tells portal pages from the rest of the app', () => {
    expect(isMerchantArea('/pay/payments/abc')).toBe(true);
    // Without a token this is the merchant's checkout settings; a payer's link carries one (see chrome/model.ts).
    expect(isMerchantArea('/pay/checkout')).toBe(true);
    expect(isMerchantArea('/pay/send')).toBe(false);
    expect(isMerchantArea('/pay/anything-else')).toBe(true);
    expect(isMerchantArea('/home')).toBe(false);
  });
  it('marks exactly one menu item current', () => {
    expect(currentHref('/pay/payments/abc')).toBe('/pay/payments');
    expect(currentHref('/pay/merchant')).toBe('/pay/merchant');
    expect(currentHref('/home')).toBeUndefined();
  });
});

describe('ComingSoonCard', () => {
  it('says what the feature will do, in plain words', () => {
    const html = renderToStaticMarkup(<ComingSoonCard>You’ll be able to send invoices.</ComingSoonCard>);
    expect(html).toContain('Coming soon');
    expect(html).toContain('You’ll be able to send invoices.');
    expect(html).not.toMatch(/backend|Arrives|Not available yet|\(W\d\)/i);
  });
});
