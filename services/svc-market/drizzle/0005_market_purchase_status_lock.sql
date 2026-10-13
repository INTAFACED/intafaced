-- intafaced:destructive — drops the CHECKs purchases_settled_has_tx_ck and purchases_rejected_has_code_ck
-- from market.purchases without re-adding them under those names. Both rules are carried by the new, stricter
-- purchases_status_fields_ck below (settled needs ledger_tx_id; rejected needs rejection_code), so no
-- invariant is lost, only merged. No row is deleted or rewritten. Reversal: the .down.sql.
-- svc-market · purchase status lock (L1229)
-- Reversal: 0005_market_purchase_status_lock.down.sql
--
-- 0002 only requires a settled row to have a ledger id and a rejected row to
-- have a code. A settled row can still keep rejection_code, a rejected row can
-- still keep ledger_tx_id and settled_at, and any status can be rewritten.
-- A posted purchase could be marked rejected with no reversing ledger entry.
--
-- This file does not post a ledger entry. It refuses that rewrite.
-- pending: ledger_tx_id, settled_at, and rejection_code are all null.
-- settled: ledger_tx_id and settled_at are set, and rejection_code is null.
-- rejected: rejection_code is set, and ledger_tx_id and settled_at are null.
-- A pending row may become settled or rejected in one update. Settled and
-- rejected do not change status. A settled ledger_tx_id is not cleared.

ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_settled_has_tx_ck";
ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_rejected_has_code_ck";
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

DROP TRIGGER IF EXISTS "purchases_status_lock_trg" ON "market"."purchases";
CREATE TRIGGER "purchases_status_lock_trg"
  BEFORE UPDATE ON "market"."purchases"
  FOR EACH ROW EXECUTE FUNCTION "market"."purchases_status_lock"();
