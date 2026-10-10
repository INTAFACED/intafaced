-- svc-pay · an execution key is required and last_attempt_at is not null.
-- Reversal: 0034_pay_subscription_execution_key_required.down.sql
-- intafaced:destructive — the partial unique index is replaced by a full
-- unique constraint. A stored null is not given a key or a timestamp.
--
-- 0011 adds subscription_executions.idempotency_key nullable, and a unique
-- index WHERE idempotency_key IS NOT NULL. One period, one key, one row holds
-- only when every writer sets the key. Any number of rows can omit it.
-- 0011 also adds last_attempt_at nullable. subscription_executions_retry_idx
-- is (status, last_attempt_at) WHERE exhausted_at IS NULL, so a cutoff on
-- last_attempt_at skips every row that left the column null.
--
-- idempotency_key becomes NOT NULL. CHECK (length(btrim(idempotency_key)) > 0)
-- refuses a blank or space-only key. The partial unique index is dropped.
-- UNIQUE (idempotency_key) is not partial. There is no default and no invented
-- key. If a stored null exists, SET NOT NULL fails and that row stays. If a
-- stored blank exists, the check fails and that row stays.
--
-- last_attempt_at gets DEFAULT now(), then SET NOT NULL. Stored rows are not
-- updated to a timestamp. If a stored null exists, SET NOT NULL fails and that
-- row stays. A new insert that omits last_attempt_at stores now(). The retry
-- index stays. Money stays numeric. No ledger post. subscriptions.idempotency_key
-- stays as 0031 left it. 0011 is already applied.

ALTER TABLE "pay"."subscription_executions"
  ALTER COLUMN "last_attempt_at" SET DEFAULT now();

ALTER TABLE "pay"."subscription_executions"
  ALTER COLUMN "last_attempt_at" SET NOT NULL;

ALTER TABLE "pay"."subscription_executions"
  ALTER COLUMN "idempotency_key" SET NOT NULL;

ALTER TABLE "pay"."subscription_executions"
  ADD CONSTRAINT "subscription_executions_idempotency_key_not_blank"
  CHECK (length(btrim("idempotency_key")) > 0);

DROP INDEX "pay"."subscription_executions_idempotency_key_idx";

ALTER TABLE "pay"."subscription_executions"
  ADD CONSTRAINT "subscription_executions_idempotency_key_uq"
  UNIQUE ("idempotency_key");
