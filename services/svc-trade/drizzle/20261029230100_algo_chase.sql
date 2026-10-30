-- trade.algo · chase: the caller's maximum distance and the start price it is measured from
-- Reversal: 20261029230100_algo_chase.down.sql

ALTER TABLE "trade"."algo_parents"
  ADD COLUMN IF NOT EXISTS "chase_max_distance_bps" integer;

ALTER TABLE "trade"."algo_parents"
  ADD COLUMN IF NOT EXISTS "chase_start_price" numeric(38, 18);

ALTER TABLE "trade"."algo_parents"
  DROP CONSTRAINT IF EXISTS "algo_parents_chase_ck";

ALTER TABLE "trade"."algo_parents"
  ADD CONSTRAINT "algo_parents_chase_ck"
  CHECK (
    ("kind" = 'chase'
      AND "chase_max_distance_bps" IS NOT NULL AND "chase_max_distance_bps" BETWEEN 1 AND 10000
      AND "chase_start_price" IS NOT NULL AND "chase_start_price" > 0
      AND "limit_price" IS NULL)
    OR
    ("kind" <> 'chase' AND "chase_max_distance_bps" IS NULL AND "chase_start_price" IS NULL)
  );
