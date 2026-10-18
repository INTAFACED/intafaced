-- Reversal of 0068_copy_follow_extra_limits.sql
ALTER TABLE "trade"."copy_follows"
  DROP CONSTRAINT IF EXISTS "copy_follows_extra_limits_ck";

ALTER TABLE "trade"."copy_follows"
  DROP COLUMN IF EXISTS "peak_result",
  DROP COLUMN IF EXISTS "max_drawdown",
  DROP COLUMN IF EXISTS "max_concurrent",
  DROP COLUMN IF EXISTS "max_slippage_bps";
