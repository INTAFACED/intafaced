-- intafaced:destructive — reversal of 0120_pay_custody_deposit_reorg.sql (drops reorg evidence)
-- destructive: drops the reorg evidence columns. Reversed and reviewed rows would violate the restored credited CHECK, so the
-- down migration refuses while any exist (their reversal ledger ids are the only link to the compensating post).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "pay"."custody_deposits" WHERE "status" = 'reversed' OR "reversal_started_at" IS NOT NULL OR "reason" IN ('chain_reorg', 'reversal_unfunded')) THEN
    RAISE EXCEPTION 'pay.custody_deposits has reorg rows; resolve them before rolling back 0120';
  END IF;
END $$;
DROP INDEX IF EXISTS "pay"."custody_deposits_reversal_idx";
ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_credited_ck";
ALTER TABLE "pay"."custody_deposits" ADD CONSTRAINT "custody_deposits_credited_ck" CHECK (("status" = 'credited') = ("credited_at" IS NOT NULL AND "ledger_tx_id" IS NOT NULL));
ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_reason_ck";
ALTER TABLE "pay"."custody_deposits" ADD CONSTRAINT "custody_deposits_reason_ck" CHECK ("reason" IS NULL OR "reason" IN
  ('below_minimum', 'amount_mismatch', 'unknown_asset', 'minimum_unset', 'confirmations_unset'));
ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_block_ck";
ALTER TABLE "pay"."custody_deposits" DROP COLUMN IF EXISTS "reversal_ledger_tx_id";
ALTER TABLE "pay"."custody_deposits" DROP COLUMN IF EXISTS "reversed_at";
ALTER TABLE "pay"."custody_deposits" DROP COLUMN IF EXISTS "reversal_started_at";
ALTER TABLE "pay"."custody_deposits" DROP COLUMN IF EXISTS "block_hash";
ALTER TABLE "pay"."custody_deposits" DROP COLUMN IF EXISTS "block_height";
