-- intafaced:destructive — reversal of 0041_pay_subscription_one_active.sql
--
-- Drops the partial unique index that refuses a second active subscription
-- for one mandate, then the unique idempotency key, the not-blank check, and
-- the column. The unique (subscription_id, occurrence) on executions stays.
-- Stored rows stay. This reversal moves no value.

DROP INDEX IF EXISTS "pay"."subscriptions_one_active_mandate_idx";

ALTER TABLE "pay"."subscriptions"
  DROP CONSTRAINT IF EXISTS "subscriptions_idempotency_key_uq";

ALTER TABLE "pay"."subscriptions"
  DROP CONSTRAINT IF EXISTS "subscriptions_idempotency_key_not_blank";

ALTER TABLE "pay"."subscriptions"
  DROP COLUMN IF EXISTS "idempotency_key";
