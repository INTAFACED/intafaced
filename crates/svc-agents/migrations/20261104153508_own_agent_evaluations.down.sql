-- Reverses the own agent evaluations migration: runs, then the test set.
DROP TABLE IF EXISTS "agents"."own_agent_eval_runs";
DROP TABLE IF EXISTS "agents"."own_agent_eval_cases";
