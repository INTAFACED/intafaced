-- Reverses 20261108231208_transfer_partner_move.sql. Refuses while any occurrence the partner made is recorded, so a
-- partner's reference is never dropped from the book of runs.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bank"."transfer_executions" WHERE "partner_move_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'transfer_executions holds partner moves; refusing to drop partner_move_id';
  END IF;
END $$;
-- Back to 0000's rule: a settled run names its ledger transaction.
ALTER TABLE "bank"."transfer_executions" DROP CONSTRAINT IF EXISTS "transfer_executions_settled_has_tx_ck";
ALTER TABLE "bank"."transfer_executions" ADD CONSTRAINT "transfer_executions_settled_has_tx_ck"
  CHECK ("status" <> 'settled' OR ("ledger_tx_id" IS NOT NULL AND "settled_at" IS NOT NULL));
ALTER TABLE "bank"."transfer_executions" DROP CONSTRAINT IF EXISTS "transfer_executions_rejected_omits_partner_move_ck";
ALTER TABLE "bank"."transfer_executions" DROP CONSTRAINT IF EXISTS "transfer_executions_one_movement_ck";
ALTER TABLE "bank"."transfer_executions" DROP COLUMN IF EXISTS "partner_move_id";
