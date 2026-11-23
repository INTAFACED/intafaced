-- Remove card_roundup from auto_invest_kind. PostgreSQL cannot DROP VALUE,
-- so recreate the 0010 type. 0015 down deletes card_roundup rows first.
-- A row that is still here makes the cast fail and this script rolls back.

ALTER TABLE "bank"."auto_invest_rules" DROP CONSTRAINT IF EXISTS "auto_invest_rules_kind_shape";

ALTER TYPE "bank"."auto_invest_kind" RENAME TO "auto_invest_kind_old";

CREATE TYPE "bank"."auto_invest_kind" AS ENUM ('threshold_sweep', 'dca');

ALTER TABLE "bank"."auto_invest_rules"
  ALTER COLUMN "kind" TYPE "bank"."auto_invest_kind"
  USING "kind"::text::"bank"."auto_invest_kind";

DROP TYPE "bank"."auto_invest_kind_old";

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
);
