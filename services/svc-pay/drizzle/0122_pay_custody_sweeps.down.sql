-- intafaced:destructive — reversal of 0122_pay_custody_sweeps.sql
--
-- Drops the sweep policy and the sweep intent rows. No customer balance lives here (a sweep never posts to the ledger);
-- an intent left `unknown` must be resolved against the chain before this is run on a database that broadcast one.

DROP INDEX IF EXISTS "pay"."custody_sweeps_pair_idx";
DROP INDEX IF EXISTS "pay"."custody_sweeps_key_uq";
DROP INDEX IF EXISTS "pay"."custody_sweeps_live_uq";
DROP INDEX IF EXISTS "pay"."custody_sweeps_intent_uq";
DROP TABLE IF EXISTS "pay"."custody_sweeps";
DROP INDEX IF EXISTS "pay"."custody_sweep_policy_pair_idx";
DROP INDEX IF EXISTS "pay"."custody_sweep_policy_task_uq";
DROP TABLE IF EXISTS "pay"."custody_sweep_policy_events";
