-- W-deposit-06 follow-up: when the last reversal attempt was made. A refusal after a retried post does not prove that an
-- earlier attempt failed to commit, so the reversal stays started. It is not posted again until
-- POST_IN_FLIGHT_BOUND_SECONDS have passed since this time. Then the ledger key is read back first. It is set with
-- `reversal_started_at` and cleared with it. No CHECK ties the two together, so code from before this column (which sets only
-- `reversal_started_at`) keeps working: a started reversal with no attempt time counts from `reversal_started_at`.
-- Reversal: 20261024171111_pay_custody_deposit_reversal_attempt.down.sql

ALTER TABLE "pay"."custody_deposits" ADD COLUMN IF NOT EXISTS "reversal_attempted_at" timestamptz;

UPDATE "pay"."custody_deposits" SET "reversal_attempted_at" = "reversal_started_at"
 WHERE "reversal_started_at" IS NOT NULL AND "reversal_attempted_at" IS NULL;
