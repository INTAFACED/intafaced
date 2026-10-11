-- A paid interest accrual with no house-ledger transaction is the same
-- phantom a settled transfer already cannot be. 0000's
-- interest_accruals_consistent_ck allows paid_amount > 0 and recipients > 0
-- while ledger_tx_id is null. transfer_executions_settled_has_tx_ck refuses
-- that shape: money recorded as moved must name the ledger transaction.
--
-- NOT VALID because rows already stored may be the paid-without-tx shape.
-- A validating CHECK would fail this migration on them. New inserts and
-- updates are still refused. This file does not update or delete any row.
--
-- Reversal: 0017_interest_accrual_paid_has_tx.down.sql

ALTER TABLE "bank"."interest_accruals" DROP CONSTRAINT IF EXISTS "interest_accruals_consistent_ck";

ALTER TABLE "bank"."interest_accruals"
  ADD CONSTRAINT "interest_accruals_consistent_ck"
  CHECK (
    ("paid_amount" = 0 AND "recipients" = 0 AND "ledger_tx_id" IS NULL)
    OR ("paid_amount" > 0 AND "recipients" > 0 AND "ledger_tx_id" IS NOT NULL)
  ) NOT VALID;
