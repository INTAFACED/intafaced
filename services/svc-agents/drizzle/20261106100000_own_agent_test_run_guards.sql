-- svc-agents · hostile content and output guards on test runs of a person's own agent (AG-guardrails-03; J-agents-10 #1-#3)
-- Reversal: 20261106100000_own_agent_test_run_guards.down.sql
--
-- An engine run may read outside content (always labelled untrusted) and may carry an output schema its reply must meet.
-- guard_json holds what the guards decided: blocked with a code, answered, or a value-moving action waiting for the
-- person's approval with the payload read from the person's own words, then approved or refused agents.payload.mismatch.
-- draft_json is the step the test engine drafted, compared with the approved payload; it is never shown. Nothing here
-- is a balance, every row is labelled TEST and costs 0, and no value moves.

ALTER TABLE "agents"."own_agent_test_runs" ADD COLUMN IF NOT EXISTS "content" text;
ALTER TABLE "agents"."own_agent_test_runs" ADD COLUMN IF NOT EXISTS "output_schema" text;
ALTER TABLE "agents"."own_agent_test_runs" ADD COLUMN IF NOT EXISTS "guard_json" jsonb;
ALTER TABLE "agents"."own_agent_test_runs" ADD COLUMN IF NOT EXISTS "draft_json" jsonb;
