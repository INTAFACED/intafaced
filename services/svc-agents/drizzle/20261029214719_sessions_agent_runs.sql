-- svc-agents · the run entity and its event trail (AG-sessions-01, ENGINE RS-1 to RS-4)
-- Reversal: 20261029214719_sessions_agent_runs.down.sql
--
-- A run row is written first, in its own transaction, before the engine is
-- called, on the business key `agents:run:<session>:<requestId>`. A repeat of the
-- same request id finds the stored run. Every state change appends one event, so
-- a reader with a cursor sees only later events. No prompt text is kept: the
-- reply, the cost the meter computed and the typed codes are all a run stores.
-- It holds no balance: `cost` is a copy of the metered amount, never a book.

CREATE TABLE IF NOT EXISTS "agents"."agent_runs" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_key"     text NOT NULL UNIQUE,
  "user_id"     text NOT NULL,
  "session_id"  uuid NOT NULL REFERENCES "agents"."agent_sessions" ("id"),
  "request_id"  text NOT NULL,
  "agent_id"    text NOT NULL,
  "task"        text,
  "state"       text NOT NULL CHECK ("state" IN ('admitted', 'running', 'waiting_approval', 'completed', 'refused', 'failed')),
  "reply"       text,
  "cost"        numeric(38, 18),
  "asset_id"    text,
  "metered"     boolean,
  "action_id"   uuid,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("session_id", "request_id"),
  CONSTRAINT "agent_runs_completed_ck" CHECK (("state" = 'completed') = ("reply" IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS "agent_runs_user_idx" ON "agents"."agent_runs" ("user_id", "created_at");

CREATE TABLE IF NOT EXISTS "agents"."agent_run_events" (
  "run_id"        uuid NOT NULL REFERENCES "agents"."agent_runs" ("id"),
  "sequence"      integer NOT NULL CHECK ("sequence" >= 1),
  "state"         text NOT NULL CHECK ("state" IN ('admitted', 'running', 'waiting_approval', 'completed', 'refused', 'failed')),
  "code"          text,
  "occurred_at"   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("run_id", "sequence")
);
