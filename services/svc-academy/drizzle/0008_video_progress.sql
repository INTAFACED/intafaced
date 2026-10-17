-- svc-academy · caller watch position
-- Reversal: 0008_video_progress.down.sql
--
-- The progress row is the last write by server time. The request row is the
-- first result of that client key, so a replay does not move the position.

CREATE TABLE IF NOT EXISTS "academy"."video_progress" (
  "user_id"            uuid NOT NULL,
  "video_slug"         text NOT NULL,
  "position_seconds"   integer NOT NULL,
  "updated_at"         timestamptz NOT NULL,
  PRIMARY KEY ("user_id", "video_slug")
);

ALTER TABLE "academy"."video_progress" DROP CONSTRAINT IF EXISTS "video_progress_position_ck";
ALTER TABLE "academy"."video_progress" ADD CONSTRAINT "video_progress_position_ck"
  CHECK ("position_seconds" >= 0);

CREATE TABLE IF NOT EXISTS "academy"."video_progress_requests" (
  "user_id"            uuid NOT NULL,
  "client_request_id"  text NOT NULL,
  "video_slug"         text NOT NULL,
  "position_seconds"   integer NOT NULL,
  PRIMARY KEY ("user_id", "client_request_id")
);
