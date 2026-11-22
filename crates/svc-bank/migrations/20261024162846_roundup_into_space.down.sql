-- Drop round-ups into spaces. Their run records go with them, as in 0015's down;
-- what moved stays in the ledger under its own-space transfer keys.

DELETE FROM "bank"."auto_invest_runs"
 WHERE "rule_id" IN (SELECT "id" FROM "bank"."auto_invest_rules" WHERE "target_space_id" IS NOT NULL);
DELETE FROM "bank"."auto_invest_rules" WHERE "target_space_id" IS NOT NULL;

DROP INDEX IF EXISTS "bank"."auto_invest_rules_target_space_idx";

ALTER TABLE "bank"."auto_invest_rules" DROP CONSTRAINT IF EXISTS "auto_invest_rules_kind_shape";

ALTER TABLE "bank"."auto_invest_rules" ADD CONSTRAINT "auto_invest_rules_kind_shape" CHECK (
  (
    "kind" = 'threshold_sweep'
    AND "threshold" IS NOT NULL AND "threshold" > 0
    AND "target_pool_id" IS NOT NULL
    AND "buy_asset_id" IS NULL AND "amount" IS NULL
    AND "cadence" IS NULL AND "next_run_at" IS NULL
  )
  OR
  (
    "kind" = 'dca'
    AND "amount" IS NOT NULL AND "amount" > 0
    AND "buy_asset_id" IS NOT NULL
    AND "cadence" IS NOT NULL AND "next_run_at" IS NOT NULL
    AND "threshold" IS NULL AND "target_pool_id" IS NULL
  )
  OR
  (
    "kind" = 'card_roundup'
    AND "amount" IS NOT NULL AND "amount" > 0
    AND "target_pool_id" IS NOT NULL
    AND "threshold" IS NULL AND "buy_asset_id" IS NULL
    AND "cadence" IS NULL AND "next_run_at" IS NULL
  )
);

ALTER TABLE "bank"."auto_invest_rules" DROP COLUMN IF EXISTS "target_space_id";
