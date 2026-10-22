-- intafaced:destructive — reversal of 0003_quant_signal_rules.sql
--
-- Drops the signal rules column and puts back the order-block check. Versions saved as signal rules have no blocks,
-- and version rows cannot be deleted, so the old check comes back NOT VALID: it holds for every new row and does not
-- re-check the old ones. Nothing here was a ledger post.

ALTER TABLE "quant"."strategy_versions" DROP CONSTRAINT IF EXISTS "strategy_versions_rules_ck";
ALTER TABLE "quant"."strategy_versions" DROP COLUMN IF EXISTS "modules";
ALTER TABLE "quant"."strategy_versions" ADD CONSTRAINT "strategy_versions_blocks_array_ck" CHECK (
  jsonb_typeof("blocks") = 'array' AND jsonb_array_length("blocks") >= 1
) NOT VALID;
