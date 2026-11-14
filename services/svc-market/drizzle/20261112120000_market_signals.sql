-- CB-bots-api-signal-05/06/07 (J-copy-bots-otc-22): published signals and the one vetting of each signal provider.
--
-- A provider is vetted once, against the owner's criteria in force (lowest verification tier, fewest own fills), and
-- the row keeps what was seen. A signal is published under the provider's own publish key, so a retried publish
-- answers the first. A free signal is a row here only; a monthly fee signal also holds one Market subscription
-- listing (`listing_id`), which is what buyers pay and what the provider's earnings read. No profit share is stored.

CREATE TABLE IF NOT EXISTS "market"."signal_vettings" (
  "vendor_id"     uuid PRIMARY KEY REFERENCES "market"."vendors" ("id"),
  "user_id"       uuid NOT NULL,
  "min_tier"      text NOT NULL,
  "min_fills"     integer NOT NULL CHECK ("min_fills" > 0),
  "tier_seen"     text NOT NULL,
  "fills_seen"    integer NOT NULL CHECK ("fills_seen" >= 0),
  "first_fill_at" timestamptz,
  "passed_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "market"."signals" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "vendor_id"          uuid NOT NULL REFERENCES "market"."vendors" ("id"),
  "publish_key"        text NOT NULL,
  "title"              text NOT NULL,
  "description"        text NOT NULL,
  "asset_id"           text NOT NULL,
  "recommended_amount" numeric(38, 18),
  "fee_model"          text NOT NULL,
  "price"              numeric(38, 18),
  "period_seconds"     integer,
  "listing_id"         uuid REFERENCES "market"."listings" ("id"),
  "status"             text NOT NULL,
  "created_at"         timestamptz NOT NULL DEFAULT now(),
  "archived_at"        timestamptz,
  CONSTRAINT "signals_fee_model_ck" CHECK ("fee_model" IN ('free', 'monthly')),
  CONSTRAINT "signals_status_ck" CHECK ("status" IN ('pending', 'published', 'archived')),
  CONSTRAINT "signals_fee_ck" CHECK (
    ("fee_model" = 'free' AND "price" IS NULL AND "period_seconds" IS NULL AND "listing_id" IS NULL)
    OR ("fee_model" = 'monthly' AND "price" > 0 AND "period_seconds" > 0)
  ),
  CONSTRAINT "signals_listed_ck" CHECK ("status" = 'pending' OR "fee_model" = 'free' OR "listing_id" IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS "signals_vendor_key_idx" ON "market"."signals" ("vendor_id", "publish_key");
CREATE INDEX IF NOT EXISTS "signals_status_created_idx" ON "market"."signals" ("status", "created_at", "id");
