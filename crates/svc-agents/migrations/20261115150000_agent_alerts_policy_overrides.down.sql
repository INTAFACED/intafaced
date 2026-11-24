-- Reverses 20261115150000_agent_alerts_policy_overrides.sql.
DROP INDEX IF EXISTS "agents"."agent_actions_time_idx";
DROP TABLE IF EXISTS "agents"."agent_policy_overrides";
DROP TABLE IF EXISTS "agents"."agent_alerts";
DROP TABLE IF EXISTS "agents"."agent_alert_rules";
