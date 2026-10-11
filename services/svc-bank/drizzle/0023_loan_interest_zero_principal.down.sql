-- Restore the 0002 check. The forward migration rewrote no row, so dropping
-- the tightened check and putting the previous one back returns the table
-- to the shape it had before.

ALTER TABLE "bank"."loan_interest_accruals" DROP CONSTRAINT IF EXISTS "loan_interest_non_negative";

ALTER TABLE "bank"."loan_interest_accruals"
  ADD CONSTRAINT "loan_interest_non_negative"
  CHECK ("interest_amount" >= 0 AND "principal_basis" >= 0);
