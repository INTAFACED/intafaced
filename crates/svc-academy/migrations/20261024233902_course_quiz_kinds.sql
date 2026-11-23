-- svc-academy · question kinds, results visibility and surveys on course quizzes, and their own attempts (AC-quizzes-02)
-- Reversal: 20261024233902_course_quiz_kinds.down.sql
--
-- A course quiz is a graded quiz or a survey. Its questions (single, multi-select, numeric, essay) stay in the quiz row's
-- jsonb. Attempts on a course quiz get their own table: an essay leaves the attempt pending review until staff score it,
-- and the score shows as the quiz's results visibility allows. Survey answers are rows of their own; an anonymous one
-- carries no account at all, only the one-way hash of a token the learner's device keeps. No money moves.

ALTER TABLE "academy"."course_quizzes"
  ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'quiz',
  ADD COLUMN IF NOT EXISTS "anonymous" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "results_visibility" text NOT NULL DEFAULT 'always';
ALTER TABLE "academy"."course_quizzes" DROP CONSTRAINT IF EXISTS "course_quizzes_kind_chk";
ALTER TABLE "academy"."course_quizzes" ADD CONSTRAINT "course_quizzes_kind_chk" CHECK (
  "kind" IN ('quiz', 'survey') AND ("kind" = 'survey' OR NOT "anonymous")
  AND "results_visibility" IN ('always', 'after_last_attempt', 'never')
  AND ("results_visibility" <> 'after_last_attempt' OR "attempt_limit" IS NOT NULL)
);
ALTER TABLE "academy"."course_quizzes" DROP CONSTRAINT IF EXISTS "course_quizzes_ready_chk";
ALTER TABLE "academy"."course_quizzes" ADD CONSTRAINT "course_quizzes_ready_chk" CHECK (
  "state" = 'draft' OR "kind" = 'survey' OR ("pass_mark" IS NOT NULL AND ("attempt_limit" = 1 OR "scoring_policy" IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS "academy"."course_quiz_attempts" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "item_id"      uuid NOT NULL REFERENCES "academy"."course_items" ("id"),
  "user_id"      uuid NOT NULL,
  "number"       integer NOT NULL,
  "started_at"   timestamptz NOT NULL,
  "deadline_at"  timestamptz,
  "quiz"         jsonb NOT NULL,
  "answers"      jsonb NOT NULL DEFAULT '{}'::jsonb,
  "finished_at"  timestamptz,
  "state"        text NOT NULL,
  "auto_score"   integer,
  "max_score"    integer,
  "essay_points" jsonb,
  "score"        integer,
  "passed"       boolean,
  "scored_by"    uuid,
  "scored_at"    timestamptz,
  CONSTRAINT "course_quiz_attempts_number_uq" UNIQUE ("item_id", "user_id", "number"),
  CONSTRAINT "course_quiz_attempts_state_chk" CHECK ("state" IN ('open', 'pending_review', 'graded')),
  CONSTRAINT "course_quiz_attempts_finished_chk" CHECK (("state" = 'open') = ("finished_at" IS NULL)),
  CONSTRAINT "course_quiz_attempts_graded_chk" CHECK (("state" = 'graded') = ("score" IS NOT NULL AND "passed" IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS "course_quiz_attempts_open_uq"
  ON "academy"."course_quiz_attempts" ("item_id", "user_id") WHERE "state" = 'open';
CREATE INDEX IF NOT EXISTS "course_quiz_attempts_review_idx"
  ON "academy"."course_quiz_attempts" ("item_id", "finished_at") WHERE "state" = 'pending_review';

CREATE TABLE IF NOT EXISTS "academy"."course_survey_responses" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "item_id"       uuid NOT NULL REFERENCES "academy"."course_items" ("id"),
  -- Null on an anonymous survey: no account, not even a hash of one, is stored with the answers.
  "user_id"       uuid,
  "token_hash"    text NOT NULL,
  "answers"       jsonb NOT NULL,
  "submitted_at"  timestamptz NOT NULL,
  CONSTRAINT "course_survey_responses_token_uq" UNIQUE ("item_id", "token_hash"),
  CONSTRAINT "course_survey_responses_hash_chk" CHECK ("token_hash" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS "course_survey_responses_user_uq"
  ON "academy"."course_survey_responses" ("item_id", "user_id") WHERE "user_id" IS NOT NULL;

-- Staff scoring an attempt's essays is an event row with who, like a save or a publish.
ALTER TABLE "academy"."course_quiz_events" DROP CONSTRAINT IF EXISTS "course_quiz_events_kind_chk";
ALTER TABLE "academy"."course_quiz_events" ADD CONSTRAINT "course_quiz_events_kind_chk"
  CHECK ("kind" IN ('saved', 'published', 'unpublished', 'essay_scored'));

-- That a learner answered a survey, with no answers and no time: each learner answers once, and an anonymous survey's
-- answers stay unlinkable to who gave them.
CREATE TABLE IF NOT EXISTS "academy"."course_survey_takers" (
  "item_id"  uuid NOT NULL REFERENCES "academy"."course_items" ("id"),
  "user_id"  uuid NOT NULL,
  PRIMARY KEY ("item_id", "user_id")
);

-- Attempts started on a course quiz before it had attempts of its own (AC-quizzes-01 used the generic attempt tables,
-- with the item id as the slug) move here, so they still count against the limit and keep the questions fixed. Their
-- questions were stored as single choice and their answers as choice ids, the same shapes as here.
INSERT INTO "academy"."course_quiz_attempts"
  ("item_id", "user_id", "number", "started_at", "deadline_at", "quiz", "answers", "finished_at", "state", "auto_score",
   "max_score", "score", "passed")
SELECT q."item_id", a."user_id", a."number", a."started_at", a."deadline_at",
       jsonb_build_object('questions', a."quiz" -> 'questions', 'passMark', (a."quiz" ->> 'passMark')::int),
       a."answers", a."finished_at", CASE WHEN a."finished_at" IS NULL THEN 'open' ELSE 'graded' END, a."score", a."max_score",
       a."score", a."passed"
FROM "academy"."quiz_attempts" a
JOIN "academy"."course_quizzes" q ON q."item_id"::text = a."slug"
ON CONFLICT ("item_id", "user_id", "number") DO NOTHING;
