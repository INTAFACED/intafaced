-- Reverse 0012_market_purchase_holds.sql
-- A hold row is the record of which ledger posts happened for a held purchase.
-- It cannot be rebuilt from anything else, so the reversal refuses while any
-- purchase was claimed with a refund window.
LOCK TABLE "market"."purchases" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "market"."purchases" WHERE "refund_window_seconds" IS NOT NULL) THEN
    RAISE EXCEPTION 'market.purchase_hold_downgrade_refused: held purchases cannot be discarded'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

DROP TABLE IF EXISTS "market"."purchase_holds";
DROP FUNCTION IF EXISTS "market"."purchase_holds_lock"();
DROP FUNCTION IF EXISTS "market"."purchase_holds_no_delete"();

DROP TRIGGER IF EXISTS "purchases_refund_window_snapshot_trg" ON "market"."purchases";
DROP FUNCTION IF EXISTS "market"."purchases_refund_window_snapshot"();
ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_refund_window_positive";
ALTER TABLE "market"."purchases" DROP COLUMN IF EXISTS "refund_window_seconds";
