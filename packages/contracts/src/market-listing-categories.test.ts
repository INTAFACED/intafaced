import { describe, expect, it } from 'vitest';
import { isMarketListingCategory, MARKET_CATEGORY_INVALID, MARKET_LISTING_CATEGORIES } from './market-listing-categories.js';

describe('market listing categories', () => {
  it('is the product enum, in order, with no owner list', () => {
    expect(MARKET_LISTING_CATEGORIES).toEqual([
      'bots',
      'defi',
      'compliance',
      'payment_extensions',
      'security_custody',
      'data',
      'advisory',
      'partner_integrations',
    ]);
    expect(new Set(MARKET_LISTING_CATEGORIES).size).toBe(MARKET_LISTING_CATEGORIES.length);
    expect(MARKET_CATEGORY_INVALID).toBe('market.category_invalid');
  });

  it('accepts only those slugs', () => {
    expect(isMarketListingCategory('bots')).toBe(true);
    expect(isMarketListingCategory('partner_integrations')).toBe(true);
    expect(isMarketListingCategory('signals')).toBe(false);
    expect(isMarketListingCategory('Bots')).toBe(false);
    expect(isMarketListingCategory('')).toBe(false);
  });
});
