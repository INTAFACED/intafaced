-- intafaced:destructive — reversal of 20261024214500_fee_tier_snapshots.sql; drops the tier snapshots (a read model: the next snapshot writes them again) and each order's tier and whether it counts toward one
DROP TABLE IF EXISTS "trade"."fee_tier_snapshot_runs";
DROP TABLE IF EXISTS "trade"."fee_tier_snapshots";
ALTER TABLE "trade"."orders"
  DROP CONSTRAINT IF EXISTS "orders_fee_tier_ck",
  DROP COLUMN IF EXISTS "fee_tier",
  DROP COLUMN IF EXISTS "tier_volume";
