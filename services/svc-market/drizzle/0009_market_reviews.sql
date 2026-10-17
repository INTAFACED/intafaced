-- svc-market · buyer reviews of settled purchases
-- Reversal: 0009_market_reviews.down.sql
--
-- One review per purchase. The buyer is the purchase buyer. There is no edit
-- and no delete. The mean is computed at read time from these scores.
-- This file does not post a ledger entry.

CREATE TABLE IF NOT EXISTS "market"."reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "purchase_id" uuid NOT NULL UNIQUE REFERENCES "market"."purchases"("id"),
  "listing_id" uuid NOT NULL,
  "vendor_id" uuid NOT NULL,
  "buyer_id" uuid NOT NULL,
  "score" integer NOT NULL
    CONSTRAINT "reviews_score_ck" CHECK ("score" >= 1 AND "score" <= 5),
  "body" text
    CONSTRAINT "reviews_body_ck" CHECK ("body" IS NULL OR length("body") <= 1000),
  "client_request_id" text NOT NULL
    CONSTRAINT "reviews_client_id_ck" CHECK (
      length(btrim("client_request_id")) > 0 AND length("client_request_id") <= 128
    ),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "reviews_buyer_client_uq" UNIQUE ("buyer_id", "client_request_id")
);

CREATE INDEX IF NOT EXISTS "reviews_listing_newest_idx"
  ON "market"."reviews" ("listing_id", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "reviews_vendor_idx"
  ON "market"."reviews" ("vendor_id");
