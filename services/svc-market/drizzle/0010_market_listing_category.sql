-- svc-market · non-strategy listing category (RC-more-catalogue-18)
-- Reversal: 0010_market_listing_category.down.sql
--
-- Category is a slug the owner published in MARKET_LISTING_CATEGORIES.
-- This migration does not seed a taxonomy. Null is a strategy or legacy
-- one-time row. A non-strategy listing writes one slug; blank is not stored.

ALTER TABLE "market"."listings"
  ADD COLUMN IF NOT EXISTS "category" text;

DO $$ BEGIN
  ALTER TABLE "market"."listings"
    ADD CONSTRAINT "listings_category_slug_ck"
    CHECK (
      "category" IS NULL
      OR (
        length("category") <= 32
        AND "category" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
      )
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "listings_category_active_idx"
  ON "market"."listings" ("category")
  WHERE "status" = 'active' AND "category" IS NOT NULL;
