-- svc-academy · quiz score changes after an attempt is graded (AC-quizzes-04)
-- Reversal: 20261030135753_quiz_score_events.down.sql
--
-- An attempt row stays as the learner finished it. Every later change to its score is an event here, numbered per attempt
-- (`override:<attempt>:<question>:<n>`, `rescore:<attempt>:<revision>`): the points each question earns after it, the
-- total before and after, whether it passes, the reason, and who. The score a learner and the gradebook see is the newest
-- event's, or the attempt's own when there is none. A key fix is a new revision of the quiz; a rescore event names the
-- revision whose keys it applied, once per attempt. No money moves.

CREATE TABLE IF NOT EXISTS "academy"."course_quiz_score_events" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "attempt_id"      uuid NOT NULL REFERENCES "academy"."course_quiz_attempts" ("id"),
  "n"               integer NOT NULL,
  "kind"            text NOT NULL,
  "question_id"     text,
  "revision"        integer,
  "points"          jsonb NOT NULL,
  "previous_score"  integer NOT NULL,
  "score"           integer NOT NULL,
  "passed"          boolean NOT NULL,
  "comment"         text,
  "reason"          text NOT NULL,
  "actor"           uuid NOT NULL,
  "at"              timestamptz NOT NULL,
  CONSTRAINT "course_quiz_score_events_key_uq" UNIQUE ("attempt_id", "n"),
  CONSTRAINT "course_quiz_score_events_n_chk" CHECK ("n" > 0),
  CONSTRAINT "course_quiz_score_events_kind_chk" CHECK (
    ("kind" = 'override' AND "question_id" IS NOT NULL) OR ("kind" = 'rescore' AND "revision" IS NOT NULL)
  ),
  CONSTRAINT "course_quiz_score_events_score_chk" CHECK ("score" >= 0 AND "previous_score" >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "course_quiz_score_events_rescore_uq"
  ON "academy"."course_quiz_score_events" ("attempt_id", "revision") WHERE "kind" = 'rescore';

-- A key fix is a quiz event of its own, with its reason.
ALTER TABLE "academy"."course_quiz_events" DROP CONSTRAINT IF EXISTS "course_quiz_events_kind_chk";
ALTER TABLE "academy"."course_quiz_events" ADD CONSTRAINT "course_quiz_events_kind_chk"
  CHECK ("kind" IN ('saved', 'published', 'unpublished', 'essay_scored', 'key_fixed'));
