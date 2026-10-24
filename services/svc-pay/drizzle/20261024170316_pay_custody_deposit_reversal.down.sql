-- Reverses 20261024170316_pay_custody_deposit_reversal.sql. Refuses while any row carries a reversal, a reversal reason or a
-- credit on a row that is no longer `credited`, or any reorg is on record: dropping those would erase the evidence that matches a ledger `depositReverse`
-- or a credit still owed a decision.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "pay"."custody_deposits"
     WHERE "reversal_started_at" IS NOT NULL OR "reversed_at" IS NOT NULL OR "reason" IN ('chain_reorg', 'reversal_unfunded')
        OR ("credited_at" IS NOT NULL AND "status" <> 'credited')
  ) OR EXISTS (SELECT 1 FROM "pay"."custody_deposit_reorgs") THEN
    RAISE EXCEPTION 'pay.custody_deposits holds reversed deposits; resolve them before removing the reversal columns';
  END IF;
END $$;

DROP TABLE IF EXISTS "pay"."custody_deposit_reorgs";
ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_reversed_ck";
ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_credited_ck";
ALTER TABLE "pay"."custody_deposits" ADD CONSTRAINT "custody_deposits_credited_ck"
  CHECK (("status" = 'credited') = ("credited_at" IS NOT NULL AND "ledger_tx_id" IS NOT NULL));
ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_reason_ck";
ALTER TABLE "pay"."custody_deposits" ADD CONSTRAINT "custody_deposits_reason_ck" CHECK ("reason" IS NULL OR "reason" IN
  ('below_minimum', 'amount_mismatch', 'unknown_asset', 'minimum_unset', 'confirmations_unset', 'address_expired'));
ALTER TABLE "pay"."custody_deposits"
  DROP COLUMN IF EXISTS "reversed_at",
  DROP COLUMN IF EXISTS "reversal_ledger_tx_id",
  DROP COLUMN IF EXISTS "reversal_started_at";
