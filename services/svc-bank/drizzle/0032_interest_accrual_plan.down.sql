-- intafaced:destructive — drops bank.interest_accruals.planned_payouts and the stored payout plan in it.
-- Rows keep paid_amount, recipients and ledger_tx_id, which is the record of what was paid. A day whose
-- plan was stored but never posted loses the plan and is planned again from live state on the next run.
-- Forward migration: 0032_interest_accrual_plan.sql
ALTER TABLE "bank"."interest_accruals" DROP COLUMN IF EXISTS "planned_payouts";
