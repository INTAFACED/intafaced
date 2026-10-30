-- trade.algo · TWAP random slice sizes fixed by a seed, and an optional trigger price that starts the schedule
-- Reversal: 20261029160000_algo_random_trigger.down.sql

ALTER TABLE "trade"."algo_parents"
  ADD COLUMN IF NOT EXISTS "random_seed" bigint;

ALTER TABLE "trade"."algo_parents"
  ADD COLUMN IF NOT EXISTS "trigger_price" numeric(38, 18);

ALTER TABLE "trade"."algo_parents"
  ADD COLUMN IF NOT EXISTS "trigger_above" boolean;

ALTER TABLE "trade"."algo_parents"
  ADD COLUMN IF NOT EXISTS "triggered_at" timestamptz;

ALTER TABLE "trade"."algo_parents"
  DROP CONSTRAINT IF EXISTS "algo_parents_random_trigger_ck";

ALTER TABLE "trade"."algo_parents"
  ADD CONSTRAINT "algo_parents_random_trigger_ck"
  CHECK (
    ("random_seed" IS NULL OR ("kind" = 'twap' AND "random_seed" >= 0 AND "random_seed" <= 4294967295))
    AND ("trigger_price" IS NULL OR ("kind" = 'twap' AND "trigger_price" > 0 AND "trigger_above" IS NOT NULL))
    AND ("triggered_at" IS NULL OR "trigger_price" IS NOT NULL)
  );
