-- svc-academy · grades hidden until a date, and the learner's planner (AC-progress-02)
-- Reversal: 0017_progress_planner.down.sql
--
-- `quizzes.results_hidden_until`: staff may hide a quiz's results until a date;
-- until then an attempt's score is pending everywhere the learner reads it.
--
-- `planner_todos`: the learner's own to-do items. `client_key` names one add,
-- so a lost reply sent again returns the stored item. Removing an item keeps
-- the row (`removed_at`), so a late replay of its add cannot bring it back.
--
-- `learning_goals`: one weekly goal per learner, with the reminder choice.

ALTER TABLE "academy"."quizzes" ADD COLUMN IF NOT EXISTS "results_hidden_until" timestamptz;

CREATE TABLE IF NOT EXISTS "academy"."planner_todos" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"     uuid NOT NULL,
  "client_key"  text NOT NULL,
  "text"        text NOT NULL,
  "created_at"  timestamptz NOT NULL,
  "done_at"     timestamptz,
  "removed_at"  timestamptz,
  CONSTRAINT "planner_todos_text_chk" CHECK (char_length(btrim("text")) BETWEEN 1 AND 200)
);
CREATE UNIQUE INDEX IF NOT EXISTS "planner_todos_key_uq" ON "academy"."planner_todos" ("user_id", "client_key");

CREATE TABLE IF NOT EXISTS "academy"."learning_goals" (
  "user_id"         uuid PRIMARY KEY,
  "items_per_week"  integer NOT NULL,
  "reminder"        boolean NOT NULL,
  "set_at"          timestamptz NOT NULL,
  CONSTRAINT "learning_goals_items_chk" CHECK ("items_per_week" BETWEEN 1 AND 100)
);

-- The date a score row's result shows, copied from the quiz when the attempt
-- finishes, so a later re-publish or take-down never releases it early.
ALTER TABLE "academy"."assessment_attempts" ADD COLUMN IF NOT EXISTS "hidden_until" timestamptz;
