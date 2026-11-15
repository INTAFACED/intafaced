-- trade.fee_tier_snapshots by instant (J-cex-spot-17 #4): the Fees and convert room sums each snapshot run's rows, and
-- the only index was (user_id, instant), so each run's sum read the whole table. An index only: no row changes.
-- Reversal: 20261106103330_fee_tier_snapshots_instant_idx.down.sql
CREATE INDEX IF NOT EXISTS "fee_tier_snapshots_instant_idx" ON "trade"."fee_tier_snapshots" ("instant");
