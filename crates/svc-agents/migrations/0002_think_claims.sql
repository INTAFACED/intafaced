-- svc-agents · think request claim
-- Reversal: 0002_think_claims.down.sql
--
-- A usage row cannot exist until the provider returns token counts, and a
-- check of that row before the call loses to any overlapping think. This
-- claim commits first. It stores no price and no token count.

CREATE TABLE IF NOT EXISTS "agents"."think_claims" (
  "session_id"   uuid NOT NULL REFERENCES "agents"."agent_sessions" ("id"),
  "request_id"   text NOT NULL,
  "claimed_at"   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("session_id", "request_id")
);
