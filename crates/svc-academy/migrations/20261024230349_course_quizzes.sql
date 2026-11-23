-- svc-academy · quizzes on the items of a course staff made, and their attempt rules (AC-quizzes-01)
-- Reversal: 20261024230349_course_quizzes.down.sql
--
-- A quiz item's questions and rules are one row, saved as a draft over the revision read. Publish needs a pass mark,
-- and a scoring policy when more than one attempt is allowed. Learners' attempts use the existing attempt tables with
-- the item id as the slug, so a published quiz with attempts keeps its questions and stays published. An access code is
-- kept only as a salted scrypt hash. Every publish and take-down is an event row with who and why. No money moves.

CREATE TABLE IF NOT EXISTS "academy"."course_quizzes" (
  "item_id"            uuid PRIMARY KEY REFERENCES "academy"."course_items" ("id") ON DELETE CASCADE,
  "revision"           integer NOT NULL,
  "state"              text NOT NULL,
  "questions"          jsonb NOT NULL,
  "pass_mark"          integer,
  "attempt_limit"      integer,
  "scoring_policy"     text,
  "time_limit_seconds" integer,
  "review_mode"        text NOT NULL,
  "access_code_hash"   text,
  "ip_allow"           text[],
  "saved_by"           uuid NOT NULL,
  "saved_at"           timestamptz NOT NULL,
  "published_at"       timestamptz,
  CONSTRAINT "course_quizzes_revision_chk" CHECK ("revision" > 0),
  CONSTRAINT "course_quizzes_state_chk" CHECK ("state" IN ('draft', 'published')),
  CONSTRAINT "course_quizzes_published_chk" CHECK (("state" = 'published') = ("published_at" IS NOT NULL)),
  CONSTRAINT "course_quizzes_pass_mark_chk" CHECK ("pass_mark" IS NULL OR "pass_mark" >= 0),
  CONSTRAINT "course_quizzes_attempt_limit_chk" CHECK ("attempt_limit" IS NULL OR "attempt_limit" > 0),
  CONSTRAINT "course_quizzes_scoring_chk" CHECK ("scoring_policy" IS NULL OR "scoring_policy" IN ('highest', 'latest', 'first', 'average')),
  CONSTRAINT "course_quizzes_time_limit_chk" CHECK ("time_limit_seconds" IS NULL OR "time_limit_seconds" > 0),
  CONSTRAINT "course_quizzes_review_chk" CHECK ("review_mode" IN ('answers', 'score_only')),
  CONSTRAINT "course_quizzes_ready_chk" CHECK (
    "state" = 'draft' OR ("pass_mark" IS NOT NULL AND ("attempt_limit" = 1 OR "scoring_policy" IS NOT NULL))
  )
);

CREATE TABLE IF NOT EXISTS "academy"."course_quiz_events" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- No foreign key: the history of who saved, published and took down a quiz outlives its item.
  "item_id"     uuid NOT NULL,
  "revision"    integer NOT NULL,
  "kind"        text NOT NULL,
  "reason"      text,
  "actor_id"    uuid NOT NULL,
  "at"          timestamptz NOT NULL,
  CONSTRAINT "course_quiz_events_kind_chk" CHECK ("kind" IN ('saved', 'published', 'unpublished'))
);
CREATE INDEX IF NOT EXISTS "course_quiz_events_item_idx" ON "academy"."course_quiz_events" ("item_id", "at" DESC);

-- Attempts on a course quiz are counted by item before an outline save or a take-down.
CREATE INDEX IF NOT EXISTS "quiz_attempts_slug_idx" ON "academy"."quiz_attempts" ("slug");
