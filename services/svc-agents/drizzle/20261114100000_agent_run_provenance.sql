-- svc-agents · where a research answer's facts came from (RC-agents-09; J-agents-10 #4)
-- Reversal: 20261114100000_agent_run_provenance.down.sql
--
-- A Navigator answer about a market keeps its provenance with its reply, in the same write that completes the run: the
-- sources the service read itself before the engine ran (market, last price, the venue's observation time), the data's
-- environment, the assumptions, the uncertainty level from the owner's scale, and every sentence that cites no source.
-- Null for any other run. A run that is not completed holds none. Nothing here is a balance and no value moves.

ALTER TABLE "agents"."agent_runs" ADD COLUMN IF NOT EXISTS "provenance" jsonb;
ALTER TABLE "agents"."agent_runs" DROP CONSTRAINT IF EXISTS "agent_runs_provenance_completed_ck";
ALTER TABLE "agents"."agent_runs"
  ADD CONSTRAINT "agent_runs_provenance_completed_ck" CHECK ("provenance" IS NULL OR "state" = 'completed');
