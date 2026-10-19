-- trade.algo · arrival mark and scheduler heartbeat (ALGORESULT)
-- Reversal: 0066_algo_result.down.sql
--
-- arrival_mark is the first mark the slice tick's mark gate accepted.
-- It is written once and never overwritten. It is not a fill, not an
-- average, and not P&L. algo.get does not return it. algo.result reads it.
-- Null means this parent was created before the column, or no mark has
-- been accepted yet (reason arrival_not_recorded on the result read).
--
-- algo_scheduler_heartbeat is one row per process instance. The tick
-- writes it. Reads only select the newest last_tick_at.

ALTER TABLE "trade"."algo_parents"
  ADD COLUMN IF NOT EXISTS "arrival_mark" numeric(38, 18),
  ADD COLUMN IF NOT EXISTS "arrival_mark_at" timestamptz;

CREATE TABLE IF NOT EXISTS "trade"."algo_scheduler_heartbeat" (
  "instance_id"   text PRIMARY KEY,
  "last_tick_at"  timestamptz NOT NULL
);
