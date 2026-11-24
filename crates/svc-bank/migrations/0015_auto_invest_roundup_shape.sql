-- Card round-up rule shape. `amount` is the granularity (round-to), not a
-- balance. Cross-asset dest is refused in the service (rate_unset), so the
-- row never stores a buy_asset_id.

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

-- One live round-up instruction per (user, funding asset). Pause/cancel free the slot.
CREATE UNIQUE INDEX IF NOT EXISTS "auto_invest_rules_one_active_roundup"
  ON "bank"."auto_invest_rules" ("user_id", "asset_id")
  WHERE "kind" = 'card_roundup' AND "status" = 'active';
