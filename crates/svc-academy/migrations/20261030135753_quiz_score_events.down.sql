-- intafaced:destructive — reversal of 20261030135753_quiz_score_events.sql
ALTER TABLE "academy"."course_quiz_events" DROP CONSTRAINT IF EXISTS "course_quiz_events_kind_chk";
DELETE FROM "academy"."course_quiz_events" WHERE "kind" = 'key_fixed';
ALTER TABLE "academy"."course_quiz_events" ADD CONSTRAINT "course_quiz_events_kind_chk"
  CHECK ("kind" IN ('saved', 'published', 'unpublished', 'essay_scored'));
DROP TABLE IF EXISTS "academy"."course_quiz_score_events";
