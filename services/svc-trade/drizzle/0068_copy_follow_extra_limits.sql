-- trade.copy · follower slippage, concurrency, and drawdown (COPYLIMITS, TRD-0676)
-- Reversal: 0068_copy_follow_extra_limits.down.sql
-- Number reserved in runs/MIGRATION-NUMBERS.md by COPYLIMITS before this file was written.
--
-- NULL means the follower did not set that axis. Bind refuses when a leader
-- recommends one and the follower gave none. No default magnitude is stored.
-- peak_result is the high-water mark of the follow's result figure. It is not
-- a limit the follower typed.

ALTER TABLE "trade"."copy_follows"
  ADD COLUMN IF NOT EXISTS "max_slippage_bps" integer,
  ADD COLUMN IF NOT EXISTS "max_concurrent" integer,
  ADD COLUMN IF NOT EXISTS "max_drawdown" numeric(38, 18),
  ADD COLUMN IF NOT EXISTS "peak_result" numeric(38, 18);

ALTER TABLE "trade"."copy_follows"
  DROP CONSTRAINT IF EXISTS "copy_follows_extra_limits_ck";

ALTER TABLE "trade"."copy_follows"
  ADD CONSTRAINT "copy_follows_extra_limits_ck"
  CHECK (
    ("max_slippage_bps" IS NULL OR ("max_slippage_bps" >= 1 AND "max_slippage_bps" <= 10000))
    AND ("max_concurrent" IS NULL OR "max_concurrent" >= 1)
    AND ("max_drawdown" IS NULL OR "max_drawdown" > 0)
  );
