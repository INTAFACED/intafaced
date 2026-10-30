-- svc-agents · one Coach run per person and request id (RC-agents-02)
-- Reversal: 20261029204423_coach_runs.down.sql
--
-- The person's request id is the business key: a retry after a lost reply reads
-- the stored answer instead of calling the engine again, and the run's charge
-- settles on its usage window's own charge key. The question is kept only as a
-- digest. It holds no balance: `billed_amount` is read back from the meter's
-- settlement, never computed here.

CREATE TABLE IF NOT EXISTS "agents"."coach_runs" (
  "user_id"          text NOT NULL,
  "request_id"       text NOT NULL,
  "session_id"       uuid NOT NULL REFERENCES "agents"."agent_sessions" ("id"),
  "run_key"          text NOT NULL UNIQUE,
  "question_digest"  text NOT NULL,
  "status"           text NOT NULL CHECK ("status" IN ('running', 'answered', 'lost')),
  "answer"           text,
  "citations"        jsonb NOT NULL DEFAULT '[]'::jsonb,
  "next_lesson"      jsonb,
  "engine"           text,
  "billed_amount"    numeric(38, 18),
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "answered_at"      timestamptz,
  PRIMARY KEY ("user_id", "request_id"),
  CONSTRAINT "coach_runs_answered_ck" CHECK (("status" = 'answered') = ("answer" IS NOT NULL))
);
