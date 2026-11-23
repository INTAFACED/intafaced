-- svc-academy · the grading policy of a course staff made (AC-assignments-04, first part)
-- Reversal: 20261025013318_course_gradebook.down.sql
--
-- Staff group the course's assignments and quizzes into types with decimal weights that add up to exactly 1, and say
-- how many of each type's lowest scores to drop. The gradebook is worked out on each read from the stored grades; nothing
-- here stores a learner's score. Every save is an event row with who and why. No money moves.

CREATE TABLE IF NOT EXISTS "academy"."course_grading_policies" (
  "course_id"  uuid PRIMARY KEY REFERENCES "academy"."courses" ("id") ON DELETE CASCADE,
  "revision"   integer NOT NULL,
  "types"      jsonb NOT NULL,
  "reason"     text NOT NULL,
  "set_by"     uuid NOT NULL,
  "set_at"     timestamptz NOT NULL,
  CONSTRAINT "course_grading_policies_revision_chk" CHECK ("revision" >= 1)
);

CREATE TABLE IF NOT EXISTS "academy"."course_grading_policy_events" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- No foreign key: the history of who set what outlives a removed course.
  "course_id"  uuid NOT NULL,
  "revision"   integer NOT NULL,
  "types"      jsonb NOT NULL,
  "reason"     text NOT NULL,
  "actor_id"   uuid NOT NULL,
  "at"         timestamptz NOT NULL,
  CONSTRAINT "course_grading_policy_events_uq" UNIQUE ("course_id", "revision")
);
