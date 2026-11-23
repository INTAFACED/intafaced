-- intafaced:destructive — replaces the status check and the waiting-only inbox index with wider ones; no row is dropped
-- Deciding an own agent's approval request (AG-approvals-01, J-agents-05 #5 #6). A request waits until its expiry, then
-- reads expired; the person approves it (the tool runs once, its first result kept; a door that refuses for good ends it
-- failed with its code), rejects it, or edits it, which replaces it with a new request for the new input. A request held before this migration had no expiry: it is given
-- its own hold time, so it reads expired and can never be approved (it fails closed).
ALTER TABLE "agents"."own_agent_approval_requests"
  ADD COLUMN IF NOT EXISTS "expires_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "decided_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "replaced_by" uuid REFERENCES "agents"."own_agent_approval_requests" ("id"),
  ADD COLUMN IF NOT EXISTS "result_json" jsonb,
  ADD COLUMN IF NOT EXISTS "ran_at" timestamptz,
  -- One runner at a time: an approved request is run only by the call that set this, until it has a result.
  ADD COLUMN IF NOT EXISTS "running_since" timestamptz,
  ADD COLUMN IF NOT EXISTS "failure_code" text;
UPDATE "agents"."own_agent_approval_requests" SET "expires_at" = "created_at" WHERE "expires_at" IS NULL;
ALTER TABLE "agents"."own_agent_approval_requests" ALTER COLUMN "expires_at" SET NOT NULL;
ALTER TABLE "agents"."own_agent_approval_requests" DROP CONSTRAINT IF EXISTS "own_agent_approval_requests_status_ck";
ALTER TABLE "agents"."own_agent_approval_requests" ADD CONSTRAINT "own_agent_approval_requests_status_ck"
  CHECK ("status" IN ('waiting', 'approved', 'rejected', 'expired', 'replaced', 'failed'));
-- A decided request names when; only a replaced one names its replacement; only an approved one holds a result.
ALTER TABLE "agents"."own_agent_approval_requests" DROP CONSTRAINT IF EXISTS "own_agent_approval_requests_decided_ck";
ALTER TABLE "agents"."own_agent_approval_requests" ADD CONSTRAINT "own_agent_approval_requests_decided_ck"
  CHECK (("status" = 'waiting') = ("decided_at" IS NULL)
     AND ("status" = 'replaced') = ("replaced_by" IS NOT NULL)
     AND ("result_json" IS NULL OR "status" = 'approved')
     AND ("ran_at" IS NULL) = ("result_json" IS NULL)
     AND ("status" = 'failed') = ("failure_code" IS NOT NULL));
-- The inbox now lists every request of the person, decided or not: waiting ones first, then newest first.
DROP INDEX IF EXISTS "agents"."own_agent_approval_requests_inbox_idx";
CREATE INDEX IF NOT EXISTS "own_agent_approval_requests_owner_idx"
  ON "agents"."own_agent_approval_requests" ("owner_id", "created_at" DESC, "id");
