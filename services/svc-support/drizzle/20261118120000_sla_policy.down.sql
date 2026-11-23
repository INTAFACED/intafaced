-- Reverses 20261118120000_sla_policy.sql.
DROP TABLE IF EXISTS "support"."sla_clocks";
DROP TRIGGER IF EXISTS "sla_policy_log_append_only_trg" ON "support"."sla_policy_log";
DROP FUNCTION IF EXISTS "support"."sla_policy_log_append_only"();
DROP TABLE IF EXISTS "support"."sla_policy_log";
DROP TABLE IF EXISTS "support"."sla_policy";
