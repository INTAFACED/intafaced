-- svc-market · listing review state and the founders' review decisions (MC-market-03, J-more-catalogue-04)
-- Reversal: 20261106090000_market_listing_review.down.sql
--
-- Every listing, of every kind, carries a review state: `applied` when published, then `approved` or
-- `rejected` by two founders (svc-market `ops.listingReview.decide`), or `taken_down` by an operator takedown. A listing
-- is public only when `approved`. Listings written before this file were never reviewed, so they start `applied` and
-- leave the shopfront until reviewed (a taken-down row stays `taken_down`). Nothing is invented as approved.
-- This file does not post a ledger entry.

ALTER TABLE "market"."listings" ADD COLUMN IF NOT EXISTS "review_state" text NOT NULL DEFAULT 'applied';
ALTER TABLE "market"."listings" ADD COLUMN IF NOT EXISTS "review_reason" text;
ALTER TABLE "market"."listings" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamptz;
ALTER TABLE "market"."listings" ADD COLUMN IF NOT EXISTS "review_ordinal" integer NOT NULL DEFAULT 1;

UPDATE "market"."listings" SET "review_state" = 'taken_down' WHERE "status" = 'taken_down' AND "review_state" <> 'taken_down';

ALTER TABLE "market"."listings" DROP CONSTRAINT IF EXISTS "listings_review_state_ck";
ALTER TABLE "market"."listings"
  ADD CONSTRAINT "listings_review_state_ck"
  CHECK ("review_state" IN ('applied', 'approved', 'rejected', 'taken_down'));

ALTER TABLE "market"."listings" DROP CONSTRAINT IF EXISTS "listings_review_ordinal_ck";
ALTER TABLE "market"."listings" ADD CONSTRAINT "listings_review_ordinal_ck" CHECK ("review_ordinal" >= 1);

-- One append-only row per decision. The business key is market:review:<listing>:<ordinal> for an approve or reject,
-- and market:takedown:<listing> for a takedown, so a decision delivered twice writes one row.
CREATE TABLE IF NOT EXISTS "market"."listing_review_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_key" text NOT NULL UNIQUE
    CONSTRAINT "listing_review_decisions_business_key_ck" CHECK (
      length(btrim("business_key")) > 0 AND length("business_key") <= 160
    ),
  "listing_id" uuid NOT NULL REFERENCES "market"."listings"("id"),
  "ordinal" integer NOT NULL CHECK ("ordinal" >= 1),
  "decision" text NOT NULL CHECK ("decision" IN ('approved', 'rejected', 'taken_down')),
  "reason" text NOT NULL CHECK (length(btrim("reason")) >= 10 AND length("reason") <= 2000),
  "actor_id" uuid NOT NULL,
  "approver_id" uuid,
  "approval_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "listing_review_decisions_listing_idx"
  ON "market"."listing_review_decisions" ("listing_id", "created_at");
CREATE INDEX IF NOT EXISTS "listings_review_queue_idx"
  ON "market"."listings" ("review_state", "created_at");
