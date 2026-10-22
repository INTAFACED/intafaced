-- intafaced:destructive — reversal of 0126_pay_subscription_retry_policy.sql
--
-- Drops the per-merchant retry policy and its history. No money lives here; the charge cycle falls back to its fixed bound.
DROP TABLE IF EXISTS "pay"."subscription_retry_final_actions";
DROP TABLE IF EXISTS "pay"."subscription_retry_policy_events";
DROP TABLE IF EXISTS "pay"."subscription_retry_policies";
