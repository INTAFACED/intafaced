-- intafaced:destructive — drops bank.interest_accruals.planned_payouts and the stored payout plans in it.
-- Rows keep paid_amount, recipients and ledger_tx_id, which record what was paid. A plan with no
-- ledger_tx_id is a day that was planned and maybe posted but not recorded. Without the column the
-- code before 0032 reads that row as a finished day, so the day would stay unpaid, or stay paid and
-- recorded as 0. The guard below refuses to roll back while any such row exists. Resume accrual first
-- (accrue the pool, or accrueAll), then roll back. Forward migration: 0032_interest_accrual_plan.sql
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "bank"."interest_accruals" WHERE "ledger_tx_id" IS NULL AND "planned_payouts" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'pending interest plans; resume accrual before rolling back';
  END IF;
END
$$;

ALTER TABLE "bank"."interest_accruals" DROP COLUMN IF EXISTS "planned_payouts";
