-- intafaced:destructive — reversal of 20261105174349_own_agent_approval_decisions.sql
-- Reverses the approval decisions migration: decided requests are removed, as the old status check allows only waiting.
DROP INDEX IF EXISTS "agents"."own_agent_approval_requests_owner_idx";
CREATE INDEX IF NOT EXISTS "own_agent_approval_requests_inbox_idx"
  ON "agents"."own_agent_approval_requests" ("owner_id", "created_at" DESC, "id")
  WHERE "status" = 'waiting';
ALTER TABLE "agents"."own_agent_approval_requests" DROP CONSTRAINT IF EXISTS "own_agent_approval_requests_decided_ck";
ALTER TABLE "agents"."own_agent_approval_requests" DROP CONSTRAINT IF EXISTS "own_agent_approval_requests_status_ck";
UPDATE "agents"."own_agent_approval_requests" SET "replaced_by" = NULL;
DELETE FROM "agents"."own_agent_approval_requests" WHERE "status" <> 'waiting';
ALTER TABLE "agents"."own_agent_approval_requests" ADD CONSTRAINT "own_agent_approval_requests_status_ck" CHECK ("status" IN ('waiting'));
ALTER TABLE "agents"."own_agent_approval_requests"
  DROP COLUMN IF EXISTS "failure_code",
  DROP COLUMN IF EXISTS "running_since",
  DROP COLUMN IF EXISTS "ran_at",
  DROP COLUMN IF EXISTS "result_json",
  DROP COLUMN IF EXISTS "replaced_by",
  DROP COLUMN IF EXISTS "decided_at",
  DROP COLUMN IF EXISTS "expires_at";
