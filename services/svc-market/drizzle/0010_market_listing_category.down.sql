-- Reverse 0010_market_listing_category.sql
DROP INDEX IF EXISTS "market"."listings_category_active_idx";
ALTER TABLE "market"."listings" DROP CONSTRAINT IF EXISTS "listings_category_slug_ck";
ALTER TABLE "market"."listings" DROP COLUMN IF EXISTS "category";
