-- intafaced:destructive — reversal of 20261029213405_team_agent_roles.sql (limits, grants and run records only, no balances)
DROP TABLE IF EXISTS "agents"."team_held_actions";
DROP TABLE IF EXISTS "agents"."team_sessions";
DROP TABLE IF EXISTS "agents"."team_project_members";
DROP TABLE IF EXISTS "agents"."team_projects";
DROP TABLE IF EXISTS "agents"."team_pool_allocations";
DROP TABLE IF EXISTS "agents"."team_pools";
DROP TABLE IF EXISTS "agents"."team_role_grants";
