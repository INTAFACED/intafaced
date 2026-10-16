import { beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComingSoonCard } from './ComingSoonCard';
import { currentHref, frameOption, isMerchantArea } from './model';

describe('portal frame option switch', () => {
  beforeEach(() => {
    try {
      sessionStorage.clear();
    } catch {
      // No storage in this environment; the switch then follows the query only.
    }
  });
  it('defaults to tabs and only honours ?frame in development', () => {
    expect(frameOption('', true)).toBe('tabs');
    expect(frameOption('?frame=nonsense', true)).toBe('tabs');
    expect(frameOption('?frame=side', false)).toBe('tabs');
    expect(frameOption('?frame=side', true)).toBe('side');
    expect(frameOption('', true)).toBe('side');
  });
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
