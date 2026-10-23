-- svc-academy · staff-published quizzes and timed attempts (AC-quizzes-03)
-- Reversal: 0016_quizzes.down.sql
--
-- `quizzes`: one quiz per curriculum item, published by staff with a reason.
-- The answer key lives in `definition` and never leaves the service. A null
-- pass mark, attempt limit or time limit means staff set none: no pass mark
-- refuses scoring, no attempt limit or time limit applies none.
--
-- `quiz_attempts`: one row per started attempt. The deadline is the server's,
-- set at start. Answers save as they are chosen. Finishing scores the saved
-- answers once and writes the score row into assessment_attempts, which
-- progress, certificates and the attempt list already read.

CREATE TABLE IF NOT EXISTS "academy"."quizzes" (
  "slug"                text PRIMARY KEY,
  "definition"          jsonb NOT NULL,
  "pass_mark"           integer,
  "attempt_limit"       integer,
  "time_limit_seconds"  integer,
  "review_mode"         text NOT NULL,
  "reason"              text NOT NULL,
  "set_by"              uuid NOT NULL,
  "set_at"              timestamptz NOT NULL,
  CONSTRAINT "quizzes_review_mode_chk" CHECK ("review_mode" IN ('answers', 'score_only')),
  CONSTRAINT "quizzes_reason_chk" CHECK (char_length(btrim("reason")) > 0),
  CONSTRAINT "quizzes_limits_chk" CHECK (
    ("pass_mark" IS NULL OR "pass_mark" >= 0)
    AND ("attempt_limit" IS NULL OR "attempt_limit" >= 1)
    AND ("time_limit_seconds" IS NULL OR "time_limit_seconds" >= 1)
  )
);

CREATE TABLE IF NOT EXISTS "academy"."quiz_attempts" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"      uuid NOT NULL,
  "slug"         text NOT NULL,
  "number"       integer NOT NULL,
  "started_at"   timestamptz NOT NULL,
  "deadline_at"  timestamptz,
  "answers"      jsonb NOT NULL DEFAULT '{}'::jsonb,
  "finished_at"  timestamptz,
  "score"        integer,
  "max_score"    integer,
  "passed"       boolean,
  CONSTRAINT "quiz_attempts_finished_chk" CHECK (("finished_at" IS NULL) = ("score" IS NULL))
);

-- One open attempt per learner and quiz: Start while one is open returns it.
CREATE UNIQUE INDEX IF NOT EXISTS "quiz_attempts_open_uq"
  ON "academy"."quiz_attempts" ("user_id", "slug") WHERE "finished_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "quiz_attempts_number_uq"
  ON "academy"."quiz_attempts" ("user_id", "slug", "number");
