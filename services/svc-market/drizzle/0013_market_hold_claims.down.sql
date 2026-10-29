-- Reverse 0013_market_hold_claims.sql
-- A clearance is the only record that a pending held claim may have a hold on the ledger; the reversal refuses while
-- any cleared claim is still pending, so no pot loses its way back.
LOCK TABLE "market"."purchases" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF to_regclass('market.purchase_hold_clearances') IS NOT NULL AND EXISTS (
    SELECT 1 FROM "market"."purchase_hold_clearances" c
      JOIN "market"."purchases" p ON p."id" = c."purchase_id"
     WHERE p."status" = 'pending'
  ) THEN
    RAISE EXCEPTION 'market.hold_claims_downgrade_refused: a cleared held claim is still pending'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

ALTER TABLE "market"."purchase_holds" DROP COLUMN IF EXISTS "next_attempt_at";
DROP TABLE IF EXISTS "market"."purchase_hold_clearances";
DROP FUNCTION IF EXISTS "market"."purchase_hold_clearances_lock"();
