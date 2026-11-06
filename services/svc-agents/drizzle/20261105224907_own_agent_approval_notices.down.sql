-- intafaced:destructive — reversal of the own agent approval notices migration
DROP INDEX IF EXISTS "agents"."own_agent_approval_requests_unpublished_idx";
ALTER TABLE "agents"."own_agent_approval_requests" DROP COLUMN IF EXISTS "published_at";
