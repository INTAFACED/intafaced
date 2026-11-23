-- svc-agents · the automatic reviewer of a person's own agent (AG-approvals-02; J-agents-05 #7)
-- Reversal: the .down.sql of the same name
--
-- A switch per agent sends the calls a rule would hold for the person to the reviewer instead, for tools that move no
-- value only. One decision per call, keyed agents:review:<session>:<request id>: proceed (the call runs once, as an
-- approval would), needs_person (held for the person) or refuse (agents.review_refused). Its reason is a code and the
-- call's input a digest, never its text. An approval request the reviewer decided says so. Nothing here moves value.

CREATE TABLE IF NOT EXISTS "agents"."own_agent_reviewer_settings" (
  "owner_id"    text NOT NULL,
  "agent_id"    uuid NOT NULL REFERENCES "agents"."own_agents" ("id"),
  "enabled"     boolean NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("owner_id", "agent_id")
);

CREATE TABLE IF NOT EXISTS "agents"."own_agent_reviews" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id"             text NOT NULL,
  "agent_id"             uuid NOT NULL REFERENCES "agents"."own_agents" ("id"),
  "session_id"           uuid NOT NULL,
  "request_id"           text NOT NULL,
  "idempotency_key"      text NOT NULL,
  "tool"                 text NOT NULL,
  "decision"             text NOT NULL,
  "reason_code"          text NOT NULL,
  "input_digest"         text NOT NULL,
  "engine"               text,
  "approval_request_id"  uuid REFERENCES "agents"."own_agent_approval_requests" ("id"),
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "own_agent_reviews_decision_ck" CHECK ("decision" IN ('proceed', 'needs_person', 'refuse')),
  CONSTRAINT "own_agent_reviews_engine_ck" CHECK ("engine" IS NULL OR "engine" IN ('test', 'live')),
  -- A refused call never becomes a request; a call that proceeds or goes to the person may name the one it became.
  CONSTRAINT "own_agent_reviews_request_ck" CHECK ("decision" <> 'refuse' OR "approval_request_id" IS NULL),
  CONSTRAINT "own_agent_reviews_key_uq" UNIQUE ("owner_id", "idempotency_key")
);
CREATE INDEX IF NOT EXISTS "own_agent_reviews_agent_idx"
  ON "agents"."own_agent_reviews" ("owner_id", "agent_id", "created_at" DESC, "id");

-- Who decided an approved or rejected request: the person, or the reviewer's proceed. Null while it waits.
ALTER TABLE "agents"."own_agent_approval_requests" ADD COLUMN IF NOT EXISTS "decided_by" text;
ALTER TABLE "agents"."own_agent_approval_requests" DROP CONSTRAINT IF EXISTS "own_agent_approval_requests_decided_by_ck";
ALTER TABLE "agents"."own_agent_approval_requests" ADD CONSTRAINT "own_agent_approval_requests_decided_by_ck"
  CHECK ("decided_by" IS NULL OR "decided_by" IN ('person', 'reviewer'));
