-- Reverses the own agent test engine runs migration: engine runs and tool tests go, dry runs stay.
DELETE FROM "agents"."own_agent_test_runs" WHERE "kind" <> 'dry_run';
ALTER TABLE "agents"."own_agent_test_runs" DROP CONSTRAINT IF EXISTS "own_agent_test_runs_kind_ck";
ALTER TABLE "agents"."own_agent_test_runs" ADD CONSTRAINT "own_agent_test_runs_kind_ck" CHECK ("kind" IN ('dry_run'));
ALTER TABLE "agents"."own_agent_test_runs" DROP COLUMN IF EXISTS "log_json";
ALTER TABLE "agents"."own_agent_test_runs" DROP COLUMN IF EXISTS "live_engine";
ALTER TABLE "agents"."own_agent_test_runs" DROP COLUMN IF EXISTS "reply";
ALTER TABLE "agents"."own_agent_test_runs" DROP COLUMN IF EXISTS "ask";
ALTER TABLE "agents"."own_agent_test_runs" ALTER COLUMN "effect_json" SET NOT NULL;
ALTER TABLE "agents"."own_agent_test_runs" ALTER COLUMN "checks_json" SET NOT NULL;
ALTER TABLE "agents"."own_agent_test_runs" ALTER COLUMN "input_json" SET NOT NULL;
ALTER TABLE "agents"."own_agent_test_runs" ALTER COLUMN "tool" SET NOT NULL;
