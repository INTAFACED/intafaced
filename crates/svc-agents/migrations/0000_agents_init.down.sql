-- intafaced:destructive — reversal of 0000_agents_init.sql
--
-- This drops the entire agent fleet runtime, including `agent_actions`.
--
-- Read that again before running it. `agent_actions` is the Agentic Law's
-- record (§8.2): the only evidence of what every agent did on every user's
-- behalf, and the only place a refusal is explained. The ledger can show that a
-- user was charged for metered usage; nothing but this table can show what the
-- usage WAS. It is not recoverable from anywhere else.
--
-- This file exists so CI can prove the migration is reversible against a
-- scratch schema (§14 DoD 1). It must never be run against a database that has
-- served a real session.
--
-- The "agents" schema itself is left in place — the bootstrap owns it, not this
-- migration (§2), and this role has no DROP SCHEMA privilege anyway.

DROP TRIGGER IF EXISTS "usage_windows_seal_once" ON "agents"."usage_windows";
DROP TRIGGER IF EXISTS "usage_records_no_late_usage" ON "agents"."usage_records";
DROP TRIGGER IF EXISTS "agent_actions_no_delete" ON "agents"."agent_actions";
DROP TRIGGER IF EXISTS "agent_actions_no_update" ON "agents"."agent_actions";

DROP FUNCTION IF EXISTS "agents"."usage_windows_seal_once"();
DROP FUNCTION IF EXISTS "agents"."usage_records_reject_sealed"();
DROP FUNCTION IF EXISTS "agents"."agent_actions_append_only"();

DROP TABLE IF EXISTS "agents"."usage_records";
DROP TABLE IF EXISTS "agents"."usage_windows";
DROP TABLE IF EXISTS "agents"."agent_place_intents";
DROP TABLE IF EXISTS "agents"."agent_actions";
DROP TABLE IF EXISTS "agents"."agent_sessions";
DROP TABLE IF EXISTS "agents"."agent_definitions";

DROP TYPE IF EXISTS "agents"."action_status";
DROP TYPE IF EXISTS "agents"."action_kind";
DROP TYPE IF EXISTS "agents"."session_status";
