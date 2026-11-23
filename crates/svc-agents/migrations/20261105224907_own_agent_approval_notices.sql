-- The owner's notice of a held tool call (AG-approvals-01, J-agents-05 #4): svc-agents publishes each request once, on
-- its id, after the commit that wrote it, and a minute sweep publishes any a crash or a bus outage left unpublished.
-- Requests written before this migration are marked as published: they were never announced, and none is announced late.
ALTER TABLE "agents"."own_agent_approval_requests" ADD COLUMN IF NOT EXISTS "published_at" timestamptz;
UPDATE "agents"."own_agent_approval_requests" SET "published_at" = "created_at" WHERE "published_at" IS NULL;
-- The sweep reads only the few requests still to publish.
CREATE INDEX IF NOT EXISTS "own_agent_approval_requests_unpublished_idx"
  ON "agents"."own_agent_approval_requests" ("created_at")
  WHERE "published_at" IS NULL;
