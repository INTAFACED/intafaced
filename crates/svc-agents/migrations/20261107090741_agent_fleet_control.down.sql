-- intafaced:destructive — reversal of 20261107090741_agent_fleet_control.sql
DROP TABLE IF EXISTS "agents"."own_agent_background_runs";
DROP TABLE IF EXISTS "agents"."agent_fleet_audit";
DROP FUNCTION IF EXISTS "agents"."agent_fleet_audit_append_only"();
DROP TABLE IF EXISTS "agents"."agent_owner_assignments";
DROP TABLE IF EXISTS "agents"."agent_kind_switches";
DROP TABLE IF EXISTS "agents"."agent_switches";
