-- svc-academy · resume point, seconds read, UTC active days
-- Reversal: 0007_learning_state.down.sql
--
-- One row per account for the resume point. One row per UTC date the account
-- opened a lesson. One row per client request so a replay does not add seconds
-- twice and still returns the first result.

CREATE TABLE IF NOT EXISTS "academy"."learning_state" (
  "user_id"         uuid PRIMARY KEY,
  "last_item_slug"  text NOT NULL,
  "last_opened_at"  timestamptz NOT NULL,
  "seconds_read"    integer NOT NULL
);

ALTER TABLE "academy"."learning_state" DROP CONSTRAINT IF EXISTS "learning_state_seconds_ck";
ALTER TABLE "academy"."learning_state" ADD CONSTRAINT "learning_state_seconds_ck"
  CHECK ("seconds_read" >= 0);

CREATE TABLE IF NOT EXISTS "academy"."learning_active_days" (
  "user_id"    uuid NOT NULL,
  "active_on"  date NOT NULL,
  PRIMARY KEY ("user_id", "active_on")
);

CREATE TABLE IF NOT EXISTS "academy"."learning_touches" (
  "user_id"            uuid NOT NULL,
  "client_request_id"  text NOT NULL,
  "item_slug"          text NOT NULL,
  "seconds_added"      integer NOT NULL,
  "touched_at"         timestamptz NOT NULL,
  "last_item_slug"     text NOT NULL,
  "last_opened_at"     timestamptz NOT NULL,
  "seconds_read"       integer NOT NULL,
  "active_days"        integer NOT NULL,
  PRIMARY KEY ("user_id", "client_request_id")
);

CREATE INDEX IF NOT EXISTS "learning_touches_day_idx"
  ON "academy"."learning_touches" ("touched_at");
