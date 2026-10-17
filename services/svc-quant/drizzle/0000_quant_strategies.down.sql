-- intafaced:destructive — reversal of 0000_quant_strategies.sql
--
-- Drops the paper tables and the immutability function. The quant schema and
-- quant.__migrations stay so the runner can record the reversal. Nothing here
-- was a ledger post.

DROP TABLE IF EXISTS "quant"."backtest_runs";
DROP TABLE IF EXISTS "quant"."write_receipts";
DROP TABLE IF EXISTS "quant"."strategy_versions";
DROP TABLE IF EXISTS "quant"."strategies";
DROP FUNCTION IF EXISTS "quant"."reject_strategy_version_mutation"();
