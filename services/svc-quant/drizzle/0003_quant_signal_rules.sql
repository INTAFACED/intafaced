-- svc-quant · signal rules from the no-code builder (AL-editor-02)
-- Reversal: 0003_quant_signal_rules.down.sql
--
-- Paper only. Signal rules are data: a symbol, a bar size, a moving-average cross, a sizing rule and optional exits,
-- with every number a decimal or integer string. No balance, no hold, no ledger post.
--
-- A version trades by order blocks or by signal rules, never both and never neither.

ALTER TABLE "quant"."strategy_versions" ADD COLUMN IF NOT EXISTS "modules" jsonb;

ALTER TABLE "quant"."strategy_versions" DROP CONSTRAINT IF EXISTS "strategy_versions_blocks_array_ck";
ALTER TABLE "quant"."strategy_versions" DROP CONSTRAINT IF EXISTS "strategy_versions_rules_ck";
ALTER TABLE "quant"."strategy_versions" ADD CONSTRAINT "strategy_versions_rules_ck" CHECK (
  jsonb_typeof("blocks") = 'array'
  AND (
    ("modules" IS NULL AND jsonb_array_length("blocks") >= 1)
    OR (
      "modules" IS NOT NULL
      AND jsonb_typeof("modules") = 'object'
      AND jsonb_array_length("blocks") = 0
      AND ("modules"->'signal'->>'fast') ~ '^[1-9][0-9]*$'
      AND ("modules"->'signal'->>'slow') ~ '^[1-9][0-9]*$'
      AND ("modules"->'sizing'->>'value') ~ '^[0-9]+(\.[0-9]{1,18})?$'
    )
  )
);
