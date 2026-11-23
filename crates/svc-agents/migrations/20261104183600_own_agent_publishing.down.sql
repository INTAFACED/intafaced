-- Reverses the own agent publishing migration.
DROP TABLE IF EXISTS "agents"."own_agent_co_owners";
DROP TABLE IF EXISTS "agents"."own_agent_surfaces";
DROP TABLE IF EXISTS "agents"."own_agent_versions";
DROP FUNCTION IF EXISTS "agents"."own_agent_versions_immutable"();
