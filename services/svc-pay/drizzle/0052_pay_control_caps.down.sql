-- intafaced:destructive — reversal of 0052_pay_control_caps.sql
--
-- Drops the cap counters and their idempotency keys. Caps would restart from zero.

DROP TABLE IF EXISTS "pay"."control_beneficiaries";
DROP TABLE IF EXISTS "pay"."control_cap_events";
DROP TABLE IF EXISTS "pay"."control_cap_usage";
