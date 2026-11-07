-- Reverses 20261106090000_market_listing_review.sql.
DROP INDEX IF EXISTS "market"."listings_review_queue_idx";
DROP TABLE IF EXISTS "market"."listing_review_decisions";
ALTER TABLE "market"."listings" DROP CONSTRAINT IF EXISTS "listings_review_ordinal_ck";
ALTER TABLE "market"."listings" DROP CONSTRAINT IF EXISTS "listings_review_state_ck";
ALTER TABLE "market"."listings" DROP COLUMN IF EXISTS "review_ordinal";
ALTER TABLE "market"."listings" DROP COLUMN IF EXISTS "reviewed_at";
ALTER TABLE "market"."listings" DROP COLUMN IF EXISTS "review_reason";
ALTER TABLE "market"."listings" DROP COLUMN IF EXISTS "review_state";
