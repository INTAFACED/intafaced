-- svc-market · listing category column (RC-more-catalogue-18)
-- Reversal: 0010_market_listing_category.down.sql
--
-- Category is a product-enum slug, or null. This migration does not seed rows.
-- Null is uncategorised: strategy listings, and one-time rows filed before a
-- category is set. 0011 tightens the check to the enum and adds the audit table.

ALTER TABLE "market"."listings"
  ADD COLUMN IF NOT EXISTS "category" text;

DO $$ BEGIN
  ALTER TABLE "market"."listings"
    ADD CONSTRAINT "listings_category_slug_ck"
    CHECK (
      "category" IS NULL
      OR "category" IN (
        'bots',
        'defi',
        'compliance',
        'payment_extensions',
        'security_custody',
        'data',
        'advisory',
        'partner_integrations'
      )
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "listings_category_active_idx"
  ON "market"."listings" ("category")
  WHERE "status" = 'active' AND "category" IS NOT NULL;
