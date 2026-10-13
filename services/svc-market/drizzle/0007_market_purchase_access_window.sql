-- svc-market · purchase access window (L1231)
-- Reversal: 0007_market_purchase_access_window.down.sql
--
-- 0003 stores access_until on the purchase and indexes every non-null window.
-- It does not require status settled or a ledger id, and it does not copy
-- period_seconds onto the purchase. A pending or rejected row can store a
-- future window and match the access index. The listing period can change
-- before settle, so the paid term is not the claim snapshot.
--
-- access_until is null unless status is settled and ledger_tx_id is not null.
-- The access index matches only that settled window.
-- purchases.period_seconds is the listing period at claim: null, or an integer
-- greater than 0. There is no default cadence. A later listing change does not
-- rewrite the purchase. This file does not post a ledger entry.

-- Preserve legacy rows. If their windows contradict settled receipt status,
-- validation refuses the upgrade; never erase access history to make it pass.

ALTER TABLE "market"."purchases"
  ADD COLUMN IF NOT EXISTS "period_seconds" integer;

ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_period_seconds_positive";
ALTER TABLE "market"."purchases"
  ADD CONSTRAINT "purchases_period_seconds_positive" CHECK (
    "period_seconds" IS NULL OR "period_seconds" > 0
  );

ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_access_until_settled_ck";
ALTER TABLE "market"."purchases"
  ADD CONSTRAINT "purchases_access_until_settled_ck" CHECK (
    "access_until" IS NULL
    OR ("status" = 'settled' AND "ledger_tx_id" IS NOT NULL)
  );

DROP INDEX IF EXISTS "market"."purchases_subscription_access_idx";
CREATE INDEX "purchases_subscription_access_idx"
  ON "market"."purchases" ("listing_id", "buyer_id")
  WHERE "access_until" IS NOT NULL
    AND "status" = 'settled'
    AND "ledger_tx_id" IS NOT NULL;

CREATE OR REPLACE FUNCTION "market"."purchases_period_snapshot"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."period_seconds" IS DISTINCT FROM OLD."period_seconds" THEN
    RAISE EXCEPTION 'market.purchases % period_seconds is the claim snapshot', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "purchases_period_snapshot_trg" ON "market"."purchases";
CREATE TRIGGER "purchases_period_snapshot_trg"
  BEFORE UPDATE ON "market"."purchases"
  FOR EACH ROW EXECUTE FUNCTION "market"."purchases_period_snapshot"();
