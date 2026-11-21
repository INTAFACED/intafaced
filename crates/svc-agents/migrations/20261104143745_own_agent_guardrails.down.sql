-- Reverses the own agent guardrails migration: approval requests, consents and rules, in that order.
DROP TABLE IF EXISTS "agents"."own_agent_approval_requests";
DROP TABLE IF EXISTS "agents"."own_agent_consents";
DROP TABLE IF EXISTS "agents"."own_agent_rules";
