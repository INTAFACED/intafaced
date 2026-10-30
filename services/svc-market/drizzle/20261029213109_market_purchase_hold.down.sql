-- Reverse 20261029213109_market_purchase_hold.sql
-- A held, released or refunded purchase is money history the older schema cannot hold. The runner holds this
-- transaction through its tracking-row delete. Exclude concurrent claims before checking for hold rows.
LOCK TABLE "market"."purchases" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "market"."purchases" WHERE "flow" <> 'pay') THEN
    RAISE EXCEPTION 'market.purchase_hold_downgrade_refused: held purchases cannot be discarded'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "market"."purchases_status_lock"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" IN ('settled', 'rejected') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'market.purchases % status % is terminal (attempted %)', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" = 'settled' AND NEW."ledger_tx_id" IS DISTINCT FROM OLD."ledger_tx_id" THEN
    RAISE EXCEPTION 'market.purchases % settled ledger_tx_id cannot be cleared or replaced', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" = 'pending'
     AND NEW."status" IS DISTINCT FROM OLD."status"
     AND NEW."status" NOT IN ('settled', 'rejected') THEN
    RAISE EXCEPTION 'market.purchases % illegal status transition pending → %', OLD."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP INDEX IF EXISTS "market"."purchases_held_window_idx";

DROP INDEX IF EXISTS "market"."purchases_subscription_access_idx";
CREATE INDEX "purchases_subscription_access_idx"
  ON "market"."purchases" ("listing_id", "buyer_id")
  WHERE "access_until" IS NOT NULL
    AND "status" = 'settled'
    AND "ledger_tx_id" IS NOT NULL;

ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_access_until_settled_ck";
ALTER TABLE "market"."purchases"
  ADD CONSTRAINT "purchases_access_until_settled_ck" CHECK (
    "access_until" IS NULL
    OR ("status" = 'settled' AND "ledger_tx_id" IS NOT NULL)
  );

ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_status_fields_ck";
ALTER TABLE "market"."purchases"
  ADD CONSTRAINT "purchases_status_fields_ck" CHECK (
    (
      "status" = 'pending'
      AND "ledger_tx_id" IS NULL
      AND "settled_at" IS NULL
      AND "rejection_code" IS NULL
    )
    OR (
      "status" = 'settled'
      AND "ledger_tx_id" IS NOT NULL
      AND "settled_at" IS NOT NULL
      AND "rejection_code" IS NULL
    )
    OR (
      "status" = 'rejected'
      AND "rejection_code" IS NOT NULL
      AND "ledger_tx_id" IS NULL
      AND "settled_at" IS NULL
    )
  );

ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_status_ck";
ALTER TABLE "market"."purchases"
  ADD CONSTRAINT "purchases_status_ck" CHECK ("status" IN ('pending', 'settled', 'rejected'));

ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_outcome_ck";
ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_flow_ck";

ALTER TABLE "market"."purchases"
  DROP COLUMN IF EXISTS "outcome_at",
  DROP COLUMN IF EXISTS "outcome_tx_id",
  DROP COLUMN IF EXISTS "outcome",
  DROP COLUMN IF EXISTS "refund_requested_at",
  DROP COLUMN IF EXISTS "refund_window_ends_at",
  DROP COLUMN IF EXISTS "hold_posted_at",
  DROP COLUMN IF EXISTS "refund_window_seconds",
  DROP COLUMN IF EXISTS "flow";
