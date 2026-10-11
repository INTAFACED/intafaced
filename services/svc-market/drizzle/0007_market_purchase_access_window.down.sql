-- Reverse 0007_market_purchase_access_window.sql
DROP TRIGGER IF EXISTS "purchases_period_snapshot_trg" ON "market"."purchases";
DROP FUNCTION IF EXISTS "market"."purchases_period_snapshot"();

ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_access_until_settled_ck";
ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_period_seconds_positive";
ALTER TABLE "market"."purchases" DROP COLUMN IF EXISTS "period_seconds";

DROP INDEX IF EXISTS "market"."purchases_subscription_access_idx";
CREATE INDEX IF NOT EXISTS "purchases_subscription_access_idx"
  ON "market"."purchases" ("listing_id", "buyer_id")
  WHERE "access_until" IS NOT NULL;
