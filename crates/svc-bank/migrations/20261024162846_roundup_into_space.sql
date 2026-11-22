-- Card round-ups into one of the person's own named spaces (BK-pots-02, J-bank-07 #3).
--
-- A round-up rule targets either an earn pool (as before) or a space, never both
-- and never neither. A space target moves the spare change with the own-space
-- bankTransfer recipe, so this adds an instruction column, never a balance.

ALTER TABLE "bank"."auto_invest_rules"
  ADD COLUMN IF NOT EXISTS "target_space_id" uuid REFERENCES "bank"."spaces" ("id");

ALTER TABLE "bank"."auto_invest_rules" DROP CONSTRAINT IF EXISTS "auto_invest_rules_kind_shape";

ALTER TABLE "bank"."auto_invest_rules" ADD CONSTRAINT "auto_invest_rules_kind_shape" CHECK (
  (
    "kind" = 'threshold_sweep'
    AND "threshold" IS NOT NULL AND "threshold" > 0
    AND "target_pool_id" IS NOT NULL AND "target_space_id" IS NULL
    AND "buy_asset_id" IS NULL AND "amount" IS NULL
    AND "cadence" IS NULL AND "next_run_at" IS NULL
  )
  OR
  (
    "kind" = 'dca'
    AND "amount" IS NOT NULL AND "amount" > 0
    AND "buy_asset_id" IS NOT NULL
    AND "cadence" IS NOT NULL AND "next_run_at" IS NOT NULL
    AND "threshold" IS NULL AND "target_pool_id" IS NULL AND "target_space_id" IS NULL
  )
  OR
  (
    "kind" = 'card_roundup'
    AND "amount" IS NOT NULL AND "amount" > 0
    AND ("target_pool_id" IS NULL) <> ("target_space_id" IS NULL)
    AND "threshold" IS NULL AND "buy_asset_id" IS NULL
    AND "cadence" IS NULL AND "next_run_at" IS NULL
  )
);

CREATE INDEX IF NOT EXISTS "auto_invest_rules_target_space_idx"
  ON "bank"."auto_invest_rules" ("target_space_id")
  WHERE "target_space_id" IS NOT NULL;
