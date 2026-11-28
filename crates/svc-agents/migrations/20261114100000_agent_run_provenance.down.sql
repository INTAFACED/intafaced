-- intafaced:destructive drops the provenance column this migration added; runs keep their reply, cost and events.
-- Reverses the agent run provenance migration.
ALTER TABLE "agents"."agent_runs" DROP CONSTRAINT IF EXISTS "agent_runs_provenance_completed_ck";
ALTER TABLE "agents"."agent_runs" DROP COLUMN IF EXISTS "provenance";
