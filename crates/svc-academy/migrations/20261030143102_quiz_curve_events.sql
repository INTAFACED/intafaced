-- svc-academy · a quiz curve file as score events (AC-quizzes-04)
-- Reversal: 20261030143102_quiz_curve_events.down.sql
--
-- A curve sets a learner's newest graded attempt to a new total from a file. Each row is a score event of kind 'curve' on
-- the attempt's trail, keyed by the file's sha256 and its line, once per attempt and file: the same file again writes
-- nothing. The difference from the questions' points is kept under the points entry '~curve', so a later override or
-- rescore keeps the curve. No money moves.

ALTER TABLE "academy"."course_quiz_score_events" ADD COLUMN IF NOT EXISTS "file_sha256" text;
ALTER TABLE "academy"."course_quiz_score_events" ADD COLUMN IF NOT EXISTS "file_line" integer;
ALTER TABLE "academy"."course_quiz_score_events" DROP CONSTRAINT IF EXISTS "course_quiz_score_events_kind_chk";
ALTER TABLE "academy"."course_quiz_score_events" ADD CONSTRAINT "course_quiz_score_events_kind_chk" CHECK (
  ("kind" = 'override' AND "question_id" IS NOT NULL) OR ("kind" = 'rescore' AND "revision" IS NOT NULL)
  OR ("kind" = 'curve' AND "file_sha256" ~ '^[0-9a-f]{64}$' AND "file_line" > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "course_quiz_score_events_curve_uq"
  ON "academy"."course_quiz_score_events" ("attempt_id", "file_sha256") WHERE "kind" = 'curve';
