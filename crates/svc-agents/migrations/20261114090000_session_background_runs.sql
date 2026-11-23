-- svc-agents · a session's background runs, and the steps each one took (AG-sessions-04, AG-control-01; J-agents-06)
-- Reversal: 20261114090000_session_background_runs.down.sql
--
-- A person starts a run on their own open session and leaves the screen: the run goes on one step at a time, each step
-- one metered engine call on the session's task, under the business key `bg:<run id>:<step>`, so a step retried after a
-- crash is metered once. A run is keyed by the person's request key, so a retried start returns the same run.
--
-- `state`: queued until its first step, then running; paused takes no new step (a step already in flight finishes);
-- completed after its last step, stopped by the person, failed on a typed refusal (`failure_code`). `stop_result` is the
-- first stop's answer, kept so a second stop returns it and settles nothing again. `notice` is the out-of-app channel the
-- person asked to be told on; the inbox row is written either way, once, after `notice_published_at` is null.
--
-- Each step row is in flight from its start until its call returned and its reply was stored; a step that finished
-- after the person pressed Stop is `done_after_stop`; one whose call was refused is `refused`, and its run failed on that
-- code. Nothing here is a balance and no value moves here: the engine's usage is metered and settled by the session's
-- own windows.

CREATE TABLE IF NOT EXISTS "agents"."session_background_runs" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"              text NOT NULL,
  "session_id"           uuid NOT NULL REFERENCES "agents"."agent_sessions" ("id"),
  "agent_id"             text NOT NULL,
  "request_key"          text NOT NULL,
  "task"                 text NOT NULL,
  "ask"                  text NOT NULL,
  "follow_ups"           jsonb NOT NULL DEFAULT '[]'::jsonb,
  "notice"               text NOT NULL,
  "steps_total"          integer NOT NULL,
  "state"                text NOT NULL DEFAULT 'queued',
  "failure_code"         text,
  "resumed_at"           timestamptz,
  "stop_result"          jsonb,
  "finished_at"          timestamptz,
  "notice_published_at"  timestamptz,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "session_background_runs_key_uq" UNIQUE ("user_id", "request_key"),
  CONSTRAINT "session_background_runs_state_ck" CHECK ("state" IN ('queued', 'running', 'paused', 'completed', 'stopped', 'failed')),
  CONSTRAINT "session_background_runs_notice_ck" CHECK ("notice" IN ('inapp', 'email', 'sms', 'push')),
  CONSTRAINT "session_background_runs_steps_ck" CHECK ("steps_total" >= 1),
  CONSTRAINT "session_background_runs_ask_ck" CHECK (length(btrim("ask")) > 0)
);

CREATE INDEX IF NOT EXISTS "session_background_runs_live_idx"
  ON "agents"."session_background_runs" ("updated_at") WHERE "state" IN ('queued', 'running', 'paused');
CREATE INDEX IF NOT EXISTS "session_background_runs_unannounced_idx"
  ON "agents"."session_background_runs" ("finished_at") WHERE "state" = 'completed' AND "notice_published_at" IS NULL;

CREATE TABLE IF NOT EXISTS "agents"."session_background_run_steps" (
  "run_id"       uuid NOT NULL REFERENCES "agents"."session_background_runs" ("id"),
  "n"            integer NOT NULL,
  "state"        text NOT NULL DEFAULT 'in_flight',
  "reply"        text,
  "cost"         text,
  "started_at"   timestamptz NOT NULL DEFAULT now(),
  "finished_at"  timestamptz,
  PRIMARY KEY ("run_id", "n"),
  CONSTRAINT "session_background_run_steps_state_ck" CHECK ("state" IN ('in_flight', 'done', 'done_after_stop', 'refused')),
  CONSTRAINT "session_background_run_steps_n_ck" CHECK ("n" >= 1),
  CONSTRAINT "session_background_run_steps_finished_ck" CHECK (("state" = 'in_flight') = ("finished_at" IS NULL))
);
