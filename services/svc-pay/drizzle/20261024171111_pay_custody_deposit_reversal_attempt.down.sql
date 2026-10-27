-- Reverses 20261024171111_pay_custody_deposit_reversal_attempt.sql. Dropping the column loses only the time of the last
-- attempt. A started reversal then counts from `reversal_started_at`, which the code before this column did not wait on.
ALTER TABLE "pay"."custody_deposits" DROP COLUMN IF EXISTS "reversal_attempted_at";
