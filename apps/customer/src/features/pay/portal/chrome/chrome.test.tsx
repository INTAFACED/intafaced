import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComingSoonCard } from './ComingSoonCard';
import { currentHref, isMerchantArea } from './model';

describe('portal chrome', () => {
  it('tells portal pages from the rest of the app', () => {
    expect(isMerchantArea('/pay/payments/abc')).toBe(true);
    expect(isMerchantArea('/pay/checkout')).toBe(false);
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
