-- svc-academy · a course's start date (AC-enrolment-01, AC-release-access-01)
-- Reversal: 0014_course_start.down.sql
--
-- One row per course (a curriculum path until courses are rows), set by staff
-- with a reason. No row means the course is self-paced and opens on
-- enrolment; nothing is ever given a start date it was not set.

CREATE TABLE IF NOT EXISTS "academy"."course_starts" (
  "path"        text PRIMARY KEY,
  "starts_at"   timestamptz NOT NULL,
  "reason"      text NOT NULL,
  "set_by"      uuid NOT NULL,
  "set_at"      timestamptz NOT NULL,
  CONSTRAINT "course_starts_reason_chk" CHECK (char_length(btrim("reason")) > 0)
);
