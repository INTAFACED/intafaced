-- Reverse 0007_market_purchase_access_window.sql
-- The claimed period is business history, not reconstructible from a live
-- listing or ledger receipt. The runner holds this transaction through its
-- tracking-row delete. Exclude concurrent claims before checking for terms.
LOCK TABLE "market"."purchases" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "market"."purchases" WHERE "period_seconds" IS NOT NULL) THEN
    RAISE EXCEPTION 'market.purchase_period_downgrade_refused: known purchase periods cannot be discarded'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS "purchases_period_snapshot_trg" ON "market"."purchases";
DROP FUNCTION IF EXISTS "market"."purchases_period_snapshot"();

ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_access_until_settled_ck";
ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_period_seconds_positive";
ALTER TABLE "market"."purchases" DROP COLUMN IF EXISTS "period_seconds";

DROP INDEX IF EXISTS "market"."purchases_subscription_access_idx";
CREATE INDEX IF NOT EXISTS "purchases_subscription_access_idx"
  ON "market"."purchases" ("listing_id", "buyer_id")
  WHERE "access_until" IS NOT NULL;
