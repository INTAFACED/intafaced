-- loan_interest_non_negative allows interest_amount > 0 when principal_basis
-- is 0, so a daily accrual row can capitalise interest on no debt.
--
-- A charge on no debt is refused. A zero charge on a zero basis still stores.
-- A positive basis still stores a positive charge and a zero charge. Negative
-- amounts stay refused. NOT VALID because rows already stored may be the old
-- shape. A validating CHECK would fail this migration on them. New inserts and
-- updates are still refused. This file does not update or delete any row.
--
-- Reversal: 0023_loan_interest_zero_principal.down.sql

ALTER TABLE "bank"."loan_interest_accruals" DROP CONSTRAINT IF EXISTS "loan_interest_non_negative";

ALTER TABLE "bank"."loan_interest_accruals"
  ADD CONSTRAINT "loan_interest_non_negative"
  CHECK (
    "interest_amount" >= 0
    AND "principal_basis" >= 0
    AND ("principal_basis" > 0 OR "interest_amount" = 0)
  ) NOT VALID;
