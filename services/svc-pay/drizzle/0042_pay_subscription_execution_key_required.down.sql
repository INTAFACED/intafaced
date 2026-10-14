-- intafaced:destructive — reversal of 0042_pay_subscription_execution_key_required.sql
--
-- Drops the not-null, the blank check, and the full unique on
-- subscription_executions.idempotency_key. Drops the not-null and the default
-- on last_attempt_at. Restores the partial unique index. Does not drop the
-- columns. The retry index stays. Stored rows stay. This reversal moves no value.

ALTER TABLE "pay"."subscription_executions"
  DROP CONSTRAINT IF EXISTS "subscription_executions_idempotency_key_uq";

ALTER TABLE "pay"."subscription_executions"
  DROP CONSTRAINT IF EXISTS "subscription_executions_idempotency_key_not_blank";

ALTER TABLE "pay"."subscription_executions"
  ALTER COLUMN "idempotency_key" DROP NOT NULL;

ALTER TABLE "pay"."subscription_executions"
  ALTER COLUMN "last_attempt_at" DROP NOT NULL;

ALTER TABLE "pay"."subscription_executions"
  ALTER COLUMN "last_attempt_at" DROP DEFAULT;

CREATE UNIQUE INDEX "subscription_executions_idempotency_key_idx"
  ON "pay"."subscription_executions" ("idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
