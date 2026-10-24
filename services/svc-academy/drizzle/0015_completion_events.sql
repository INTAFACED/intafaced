-- svc-academy · completion history: every Complete and every Undo (AC-progress-01)
-- Reversal: 0015_completion_events.down.sql
--
-- cert_item_completions holds what is complete now, one row per learner and
-- item. This table keeps what happened: a completion appends 'completed', an
-- Undo appends 'undone' and removes the current row, and completing again
-- appends a new 'completed'. An Undo is keyed by the learner's request id, so
-- a replay returns the first answer and writes nothing twice.

CREATE TABLE IF NOT EXISTS "academy"."item_completion_events" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"            uuid NOT NULL,
  "item_slug"          text NOT NULL,
  "event"              text NOT NULL,
  "client_request_id"  text,
  "recorded_at"        timestamptz NOT NULL,
  CONSTRAINT "item_completion_events_event_chk" CHECK ("event" IN ('completed', 'undone'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "item_completion_events_request_uq"
  ON "academy"."item_completion_events" ("user_id", "client_request_id")
  WHERE "client_request_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "item_completion_events_user_item_idx"
  ON "academy"."item_completion_events" ("user_id", "item_slug", "recorded_at");
