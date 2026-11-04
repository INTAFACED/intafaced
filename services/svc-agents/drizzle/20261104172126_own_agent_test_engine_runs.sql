-- svc-agents · test engine runs and tool tests of a person's own agent (AG-testing-01; J-agents-04 #1, #2)
-- Reversal: 20261104172126_own_agent_test_engine_runs.down.sql
--
-- Two more kinds of test run beside the dry run. An engine run asks the agent once on the test engine (fixed replies,
-- no model, never billed) and keeps its question, reply, log and the deployment's live engine at the time. A tool test
-- reports what a tool that moves value would do and sends nothing. Neither opens a session, holds a reservation, writes
-- a usage row or calls the ledger. Every row is labelled TEST. Nothing here is a balance.

ALTER TABLE "agents"."own_agent_test_runs" ALTER COLUMN "tool" DROP NOT NULL;
ALTER TABLE "agents"."own_agent_test_runs" ALTER COLUMN "input_json" DROP NOT NULL;
ALTER TABLE "agents"."own_agent_test_runs" ALTER COLUMN "checks_json" DROP NOT NULL;
ALTER TABLE "agents"."own_agent_test_runs" ALTER COLUMN "effect_json" DROP NOT NULL;
ALTER TABLE "agents"."own_agent_test_runs" ADD COLUMN IF NOT EXISTS "ask" text;
ALTER TABLE "agents"."own_agent_test_runs" ADD COLUMN IF NOT EXISTS "reply" text;
ALTER TABLE "agents"."own_agent_test_runs" ADD COLUMN IF NOT EXISTS "live_engine" text;
ALTER TABLE "agents"."own_agent_test_runs" ADD COLUMN IF NOT EXISTS "log_json" jsonb;
ALTER TABLE "agents"."own_agent_test_runs" DROP CONSTRAINT IF EXISTS "own_agent_test_runs_kind_ck";
ALTER TABLE "agents"."own_agent_test_runs" ADD CONSTRAINT "own_agent_test_runs_kind_ck" CHECK (
  ("kind" IN ('dry_run', 'tool_test')
    AND "tool" IS NOT NULL AND "input_json" IS NOT NULL AND "checks_json" IS NOT NULL AND "effect_json" IS NOT NULL)
  OR ("kind" = 'engine_run'
    AND "ask" IS NOT NULL AND "reply" IS NOT NULL AND "log_json" IS NOT NULL
    AND "live_engine" IN ('sandbox', 'live', 'unknown'))
);
