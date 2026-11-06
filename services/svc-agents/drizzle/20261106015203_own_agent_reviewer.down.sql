-- intafaced:destructive — reversal of the own agent reviewer migration
ALTER TABLE "agents"."own_agent_approval_requests" DROP CONSTRAINT IF EXISTS "own_agent_approval_requests_decided_by_ck";
ALTER TABLE "agents"."own_agent_approval_requests" DROP COLUMN IF EXISTS "decided_by";
DROP TABLE IF EXISTS "agents"."own_agent_reviews";
DROP TABLE IF EXISTS "agents"."own_agent_reviewer_settings";
