-- intafaced:destructive — reversal of 0081_pay_subscription_create_idempotency.sql
--
-- Drops the subscription.create idempotency journal and the one-open-subscription
-- index. Subscription rows stay. No ledger data is touched.

DROP TABLE IF EXISTS "pay"."subscription_create_idempotency";
DROP INDEX IF EXISTS "pay"."subscriptions_one_open_per_mandate_uq";
