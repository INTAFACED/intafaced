import { z } from 'zod';
import { MarketError } from '../vendor-service.js';

/** Owner has not published MARKET_LISTING_CATEGORIES. Not an empty shop list. */
export const MARKET_CATEGORY_TAXONOMY_UNSET = 'market.category_taxonomy_unset' as const;

/** Caller omitted the category, or sent only whitespace. Not "all categories". */
export const MARKET_LISTING_CATEGORY_UNSET = 'market.listing_category_unset' as const;

/** Slug is not in the published taxonomy. The service does not add it. */
export const MARKET_LISTING_CATEGORY_UNKNOWN = 'market.listing_category_unknown' as const;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG = 32;
const MAX_CATEGORIES = 64;

/**
 * Owner taxonomy from MARKET_LISTING_CATEGORIES.
 * Blank / whitespace is unset. There is no built-in category list.
 * A hole, duplicate, or slug outside `[a-z0-9-]{1,32}` throws — it is not dropped.
 */
export function readListingCategories(value: unknown): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error('MARKET_LISTING_CATEGORIES must be a comma-separated string');
  }
  if (value.trim() === '') return undefined;
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length > MAX_CATEGORIES) {
    throw new Error('MARKET_LISTING_CATEGORIES has more than 64 slugs');
  }
  const seen = new Set<string>();
  for (const part of parts) {
    if (part.length === 0 || part.length > MAX_SLUG || !SLUG.test(part) || seen.has(part)) {
      throw new Error('MARKET_LISTING_CATEGORIES has a blank, duplicate, or invalid slug');
    }
    seen.add(part);
  }
  return parts;
}

export const marketListingCategoriesSchema: z.ZodType<readonly string[] | undefined> = z.any().transform((value, ctx) => {
  try {
    return readListingCategories(value);
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: err instanceof Error ? err.message : 'MARKET_LISTING_CATEGORIES is invalid',
    });
    return z.NEVER;
  }
});

export function requireListingTaxonomy(taxonomy: readonly string[] | null | undefined): readonly string[] {
  if (taxonomy == null || taxonomy.length === 0) {
    throw new MarketError(MARKET_CATEGORY_TAXONOMY_UNSET, MARKET_CATEGORY_TAXONOMY_UNSET);
  }
  return [...taxonomy];
}

/** Trimmed slug that is in the published taxonomy. Blank is not "any". */
export function assertListingCategory(taxonomy: readonly string[] | null | undefined, category: string | null | undefined): string {
  if (category == null || category.trim() === '') {
    throw new MarketError(MARKET_LISTING_CATEGORY_UNSET, MARKET_LISTING_CATEGORY_UNSET);
  }
  const published = requireListingTaxonomy(taxonomy);
  const slug = category.trim();
  if (!published.includes(slug)) {
    throw new MarketError(MARKET_LISTING_CATEGORY_UNKNOWN, MARKET_LISTING_CATEGORY_UNKNOWN);
  }
  return slug;
}
