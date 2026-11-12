-- svc-academy · learning analytics and the reports centre (AC-analytics-01, AC-analytics-02; J-academy-16)
-- Reversal: 20261112123831_academy_reports.down.sql
--
-- metrics_recording holds the first moment the service recorded learning activity: when this migration ran, or the
-- oldest lesson read, completion or grant already stored if that is earlier. The daily activity table says "not
-- recorded" for a day before it, never zero.
--
-- report_tasks holds the reports staff request. A task is written first (queued); the report sweep moves it to running
-- and, on its next pass, stores the file (its CSV, row count and SHA-256) and marks it done, or failed with the refusal
-- that stopped it. Staff may abort a queued or running task (no file is ever served for it) and delete any task: a
-- deleted task leaves the list and its file is dropped. A file is served until expires_at (the owner's retention), after
-- which the sweep drops its bytes. A founder's requests are numbered (report:<kind>:<founder>:<n>), so a retried request
-- finds the task it made. report_task_events records who did what to a task, and when. No money moves.

CREATE TABLE IF NOT EXISTS "academy"."metrics_recording" (
  "id"     smallint PRIMARY KEY DEFAULT 1,
  "since"  timestamptz NOT NULL,
  CONSTRAINT "metrics_recording_one_row_chk" CHECK ("id" = 1)
);

INSERT INTO "academy"."metrics_recording" ("id", "since")
SELECT 1, LEAST(
  now(),
  (SELECT min("touched_at") FROM "academy"."learning_touches"),
  (SELECT min("completed_at") FROM "academy"."cert_item_completions"),
  (SELECT min("granted_at") FROM "academy"."cert_grants")
)
ON CONFLICT ("id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "academy"."report_tasks" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "requested_by"  uuid NOT NULL,
  "n"             integer NOT NULL,
  "kind"          text NOT NULL,
  "tag"           text,
  "state"         text NOT NULL,
  "requested_at"  timestamptz NOT NULL,
  "started_at"    timestamptz,
  "finished_at"   timestamptz,
  "expires_at"    timestamptz,
  "csv"           text,
  "rows"          integer,
  "sha256"        text,
  "failure"       text,
  "deleted_at"    timestamptz,
  CONSTRAINT "report_tasks_key_uq" UNIQUE ("requested_by", "n"),
  CONSTRAINT "report_tasks_n_chk" CHECK ("n" >= 1),
  CONSTRAINT "report_tasks_kind_chk" CHECK ("kind" IN ('learners')),
  CONSTRAINT "report_tasks_state_chk" CHECK ("state" IN ('queued', 'running', 'done', 'aborted', 'failed')),
  CONSTRAINT "report_tasks_sha256_chk" CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "report_tasks_file_chk" CHECK ("csv" IS NULL OR "state" = 'done')
);

CREATE INDEX IF NOT EXISTS "report_tasks_open_idx" ON "academy"."report_tasks" ("state", "requested_at") WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "report_tasks_list_idx" ON "academy"."report_tasks" ("requested_at" DESC) WHERE "deleted_at" IS NULL;

CREATE TABLE IF NOT EXISTS "academy"."report_task_events" (
  "task_id"   uuid NOT NULL REFERENCES "academy"."report_tasks" ("id") ON DELETE CASCADE,
  "n"         integer NOT NULL,
  "event"     text NOT NULL,
  "actor_id"  uuid,
  "at"        timestamptz NOT NULL,
  PRIMARY KEY ("task_id", "n"),
  CONSTRAINT "report_task_events_event_chk" CHECK ("event" IN ('requested', 'started', 'done', 'failed', 'aborted', 'deleted', 'expired'))
);
