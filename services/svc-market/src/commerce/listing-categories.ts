import { isMarketListingCategory, MARKET_LISTING_CATEGORIES, type MarketListingCategory } from '@intafaced/contracts';
import { MarketError } from '../vendor-service.js';

/** Slug is not in the product enum. The service does not add it. */
export const MARKET_CATEGORY_INVALID = 'market.category_invalid' as const;

/**
 * A door that must name one category was given nothing.
 * Not "every listing". Omitted on create is uncategorised, not this code.
 */
export const MARKET_LISTING_CATEGORY_UNSET = 'market.listing_category_unset' as const;

/** Operator reason missing or shorter than an audit sentence. */
export const MARKET_CATEGORY_REASON_SHORT = 'market.category_reason_short' as const;

/** Idempotency business key missing. Not a client request id from another door. */
export const MARKET_CATEGORY_BUSINESS_KEY_REQUIRED = 'market.category_business_key_required' as const;

export const MARKET_CATEGORY_NOT_WRITTEN = 'market.category_not_written' as const;

/** Copy of the product enum. A caller mutation does not change the next read. */
export function listingCategoryEnum(): readonly MarketListingCategory[] {
  return [...MARKET_LISTING_CATEGORIES];
}

/** Present slug must be the product enum. Blank is not a slug. */
export function requireListingCategory(category: string | null | undefined): MarketListingCategory {
  if (category == null || category.trim() === '') {
    throw new MarketError(MARKET_LISTING_CATEGORY_UNSET, MARKET_LISTING_CATEGORY_UNSET);
  }
  const slug = category.trim();
  if (!isMarketListingCategory(slug)) {
    throw new MarketError(MARKET_CATEGORY_INVALID, MARKET_CATEGORY_INVALID);
  }
  return slug;
}

/**
 * Create path. Null, omitted, and whitespace are uncategorised (null).
 * A category is checked only when one is given.
 */
export function optionalListingCategory(category: string | null | undefined): MarketListingCategory | null {
  if (category == null || category.trim() === '') return null;
  return requireListingCategory(category);
}
