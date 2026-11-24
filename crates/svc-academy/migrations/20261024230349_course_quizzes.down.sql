-- intafaced:destructive — reversal of 20261024230349_course_quizzes.sql
DROP INDEX IF EXISTS "academy"."quiz_attempts_slug_idx";
DROP TABLE IF EXISTS "academy"."course_quiz_events";
DROP TABLE IF EXISTS "academy"."course_quizzes";
