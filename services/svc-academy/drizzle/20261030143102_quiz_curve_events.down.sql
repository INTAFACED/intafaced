-- intafaced:destructive — reversal of 20261030143102_quiz_curve_events.sql
DROP INDEX IF EXISTS "academy"."course_quiz_score_events_curve_uq";
DELETE FROM "academy"."course_quiz_score_events" WHERE "kind" = 'curve';
ALTER TABLE "academy"."course_quiz_score_events" DROP CONSTRAINT IF EXISTS "course_quiz_score_events_kind_chk";
ALTER TABLE "academy"."course_quiz_score_events" ADD CONSTRAINT "course_quiz_score_events_kind_chk" CHECK (
  ("kind" = 'override' AND "question_id" IS NOT NULL) OR ("kind" = 'rescore' AND "revision" IS NOT NULL)
);
ALTER TABLE "academy"."course_quiz_score_events" DROP COLUMN IF EXISTS "file_line";
ALTER TABLE "academy"."course_quiz_score_events" DROP COLUMN IF EXISTS "file_sha256";
