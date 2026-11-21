-- intafaced:destructive — reversal of 20261113213343_own_agent_memory.sql
ALTER TABLE "agents"."own_agent_test_runs" DROP COLUMN IF EXISTS "memory_json";
DROP TABLE IF EXISTS "agents"."own_agent_data_controls";
DROP TABLE IF EXISTS "agents"."own_agent_memory";
