ALTER TABLE "academy"."assessment_attempts" DROP COLUMN IF EXISTS "hidden_until";
DROP TABLE IF EXISTS "academy"."learning_goals";
DROP TABLE IF EXISTS "academy"."planner_todos";
ALTER TABLE "academy"."quizzes" DROP COLUMN IF EXISTS "results_hidden_until";
