-- intafaced:destructive — reversal of 20261031050905_worker_states.sql
-- Every recorded worker state change, evaluation time, maintenance row and alert-limit choice is lost.
DROP INDEX IF EXISTS "mining_pool"."shares_unlabelled_miner_created_idx";
DROP TABLE IF EXISTS "mining_pool"."worker_alert_limits";
DROP TABLE IF EXISTS "mining_pool"."worker_maintenance";
DROP TABLE IF EXISTS "mining_pool"."worker_evaluations";
DROP TABLE IF EXISTS "mining_pool"."worker_state_changes";
