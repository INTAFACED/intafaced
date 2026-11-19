-- intafaced:destructive — reversal of 20261024233902_course_quiz_kinds.sql
DROP TABLE IF EXISTS "academy"."course_survey_takers";
DROP TABLE IF EXISTS "academy"."course_survey_responses";
DROP TABLE IF EXISTS "academy"."course_quiz_attempts";
ALTER TABLE "academy"."course_quizzes" DROP CONSTRAINT IF EXISTS "course_quizzes_ready_chk";
ALTER TABLE "academy"."course_quizzes" DROP CONSTRAINT IF EXISTS "course_quizzes_kind_chk";
DELETE FROM "academy"."course_quizzes" WHERE "kind" = 'survey';
ALTER TABLE "academy"."course_quizzes" ADD CONSTRAINT "course_quizzes_ready_chk" CHECK (
  "state" = 'draft' OR ("pass_mark" IS NOT NULL AND ("attempt_limit" = 1 OR "scoring_policy" IS NOT NULL))
);
ALTER TABLE "academy"."course_quizzes"
  DROP COLUMN IF EXISTS "results_visibility",
  DROP COLUMN IF EXISTS "anonymous",
  DROP COLUMN IF EXISTS "kind";
ALTER TABLE "academy"."course_quiz_events" DROP CONSTRAINT IF EXISTS "course_quiz_events_kind_chk";
DELETE FROM "academy"."course_quiz_events" WHERE "kind" = 'essay_scored';
ALTER TABLE "academy"."course_quiz_events" ADD CONSTRAINT "course_quiz_events_kind_chk"
  CHECK ("kind" IN ('saved', 'published', 'unpublished'));
