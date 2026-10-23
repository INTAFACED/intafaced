-- intafaced:destructive — reversal of 0003_quant_signal_rules.sql
--
-- Drops the signal rules column and puts back the order-block check. Signal rules live only in that column (the
-- stored source is a view of them) and version rows cannot be deleted, so the reversal refuses while any version holds
-- signal rules instead of throwing them away. Nothing here was a ledger post.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'quant' AND table_name = 'strategy_versions' AND column_name = 'modules'
  ) AND EXISTS (SELECT 1 FROM "quant"."strategy_versions" WHERE "modules" IS NOT NULL) THEN
    RAISE EXCEPTION 'quant.signal_rules_present — versions with signal rules exist; this reversal would lose them';
  END IF;
END
$$;

ALTER TABLE "quant"."strategy_versions" DROP CONSTRAINT IF EXISTS "strategy_versions_rules_ck";
ALTER TABLE "quant"."strategy_versions" DROP COLUMN IF EXISTS "modules";
ALTER TABLE "quant"."strategy_versions" ADD CONSTRAINT "strategy_versions_blocks_array_ck" CHECK (
  jsonb_typeof("blocks") = 'array' AND jsonb_array_length("blocks") >= 1
);
