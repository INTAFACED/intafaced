-- intafaced:destructive — reversal of 0001_quant_runs.sql
--
-- Drops paper run records and claims. Nothing here was a ledger post.

DROP TABLE IF EXISTS "quant"."claims";
DROP TABLE IF EXISTS "quant"."runs";
DROP FUNCTION IF EXISTS "quant"."reject_claim_mutation"();
DROP FUNCTION IF EXISTS "quant"."reject_run_rewrite"();
