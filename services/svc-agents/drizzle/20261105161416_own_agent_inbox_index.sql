-- The Approvals inbox (AG-approvals-01) reads one person's waiting requests across all their agents, newest first.
CREATE INDEX IF NOT EXISTS "own_agent_approval_requests_inbox_idx"
  ON "agents"."own_agent_approval_requests" ("owner_id", "created_at" DESC, "id")
  WHERE "status" = 'waiting';
