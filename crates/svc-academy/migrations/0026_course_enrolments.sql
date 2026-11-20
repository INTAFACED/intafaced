-- svc-academy · learners enrolled in a course staff made (AC-enrolment-01, AC-catalogue-03)
-- Reversal: 0026_course_enrolments.down.sql
--
-- One row per enrolment, keyed `enrol:<user>:<course>` by the one open row a
-- learner may hold in a course. Leaving closes the row (left_at) rather than
-- deleting it; enrolling again opens a new one. Only the free audit track is
-- open: the paid track waits on course payments (AC-commerce-01). No money moves.

CREATE TABLE IF NOT EXISTS "academy"."course_enrolments" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "course_id"    uuid NOT NULL REFERENCES "academy"."courses" ("id"),
  "user_id"      uuid NOT NULL,
  "track"        text NOT NULL,
  "enrolled_at"  timestamptz NOT NULL,
  "left_at"      timestamptz,
  CONSTRAINT "course_enrolments_track_chk" CHECK ("track" IN ('audit')),
  CONSTRAINT "course_enrolments_left_chk" CHECK ("left_at" IS NULL OR "left_at" >= "enrolled_at")
);
CREATE UNIQUE INDEX IF NOT EXISTS "course_enrolments_open_uq"
  ON "academy"."course_enrolments" ("course_id", "user_id") WHERE "left_at" IS NULL;
CREATE INDEX IF NOT EXISTS "course_enrolments_user_idx" ON "academy"."course_enrolments" ("user_id", "enrolled_at" DESC);
