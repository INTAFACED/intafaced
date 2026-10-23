-- svc-market · operator set of a listing category (RC-more-catalogue-18)
-- Reversal: 0011_market_listing_category_event.down.sql
--
-- One business key, one audit row. The listing slug and this row commit
-- together. A retry of the same key reads the row and does not write again.
-- This file does not post a ledger entry.
--
-- Replaces the slug pattern from 0010 with the product enum. Null stays
-- uncategorised (strategy rows, and one-time rows filed before a category).

ALTER TABLE "market"."listings" DROP CONSTRAINT IF EXISTS "listings_category_slug_ck";

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

CREATE TABLE IF NOT EXISTS "market"."listing_category_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_key" text NOT NULL
    CONSTRAINT "listing_category_events_business_key_ck" CHECK (
      length(btrim("business_key")) > 0 AND length("business_key") <= 128
    ),
  "listing_id" uuid NOT NULL REFERENCES "market"."listings"("id"),
  "category" text NOT NULL
    CONSTRAINT "listing_category_events_category_ck" CHECK (
      "category" IN (
        'bots',
        'defi',
        'compliance',
        'payment_extensions',
        'security_custody',
        'data',
        'advisory',
        'partner_integrations'
      )
    ),
  "actor_id" uuid NOT NULL,
  "reason" text NOT NULL
    CONSTRAINT "listing_category_events_reason_ck" CHECK (
      length(btrim("reason")) >= 10 AND length("reason") <= 2000
    ),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "listing_category_events_business_key_uq" UNIQUE ("business_key")
);

CREATE INDEX IF NOT EXISTS "listing_category_events_listing_idx"
  ON "market"."listing_category_events" ("listing_id", "created_at" ASC, "id" ASC);

CREATE OR REPLACE FUNCTION "market"."listing_category_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'market.listing_category_events is append-only'
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS "listing_category_events_append_only_trg" ON "market"."listing_category_events";
CREATE TRIGGER "listing_category_events_append_only_trg"
  BEFORE UPDATE OR DELETE ON "market"."listing_category_events"
  FOR EACH ROW EXECUTE FUNCTION "market"."listing_category_events_append_only"();
