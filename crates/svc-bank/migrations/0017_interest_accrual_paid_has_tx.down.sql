-- Restore the 0000 check. The forward migration added no column and rewrote
-- no row, so dropping the tightened check and putting the previous one back
-- returns the table to the shape it had before.
ALTER TABLE "bank"."interest_accruals" DROP CONSTRAINT IF EXISTS "interest_accruals_consistent_ck";

ALTER TABLE "bank"."interest_accruals" ADD CONSTRAINT "interest_accruals_consistent_ck"
  CHECK (("paid_amount" = 0 AND "recipients" = 0 AND "ledger_tx_id" IS NULL)
      OR ("paid_amount" > 0 AND "recipients" > 0));
