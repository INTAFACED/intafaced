/**
 * Marketplace listing categories (RC-more-catalogue-18).
 *
 * A product enum, not an owner env list. Strategy listings stay uncategorised
 * until a later slice. Null on a one-time row means uncategorised.
 */

export const MARKET_LISTING_CATEGORIES = [
  'bots',
  'defi',
  'compliance',
  'payment_extensions',
  'security_custody',
  'data',
  'advisory',
  'partner_integrations',
] as const;

export type MarketListingCategory = (typeof MARKET_LISTING_CATEGORIES)[number];

export const MARKET_CATEGORY_INVALID = 'market.category_invalid' as const;

export function isMarketListingCategory(value: string): value is MarketListingCategory {
  return (MARKET_LISTING_CATEGORIES as readonly string[]).includes(value);
}
