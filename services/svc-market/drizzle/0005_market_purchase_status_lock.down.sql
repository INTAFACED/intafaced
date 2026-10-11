-- Reverse 0005_market_purchase_status_lock.sql
DROP TRIGGER IF EXISTS "purchases_status_lock_trg" ON "market"."purchases";
DROP FUNCTION IF EXISTS "market"."purchases_status_lock"();

ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_status_fields_ck";

ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_settled_has_tx_ck";
ALTER TABLE "market"."purchases"
  ADD CONSTRAINT "purchases_settled_has_tx_ck" CHECK (
    ("status" <> 'settled') OR ("ledger_tx_id" IS NOT NULL AND "settled_at" IS NOT NULL)
  );

ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_rejected_has_code_ck";
ALTER TABLE "market"."purchases"
  ADD CONSTRAINT "purchases_rejected_has_code_ck" CHECK (
    ("status" <> 'rejected') OR ("rejection_code" IS NOT NULL)
  );
