-- intafaced:destructive drops the guard columns this migration added (content, output_schema, guard_json, draft_json); engine runs keep their question, reply and log.
-- Reverses the own agent test run guards migration.
ALTER TABLE "agents"."own_agent_test_runs" DROP COLUMN IF EXISTS "draft_json";
ALTER TABLE "agents"."own_agent_test_runs" DROP COLUMN IF EXISTS "guard_json";
ALTER TABLE "agents"."own_agent_test_runs" DROP COLUMN IF EXISTS "output_schema";
ALTER TABLE "agents"."own_agent_test_runs" DROP COLUMN IF EXISTS "content";
