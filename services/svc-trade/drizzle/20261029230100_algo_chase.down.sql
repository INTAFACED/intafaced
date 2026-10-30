-- Reverse 20261029230100_algo_chase.sql
ALTER TABLE "trade"."algo_parents" DROP CONSTRAINT IF EXISTS "algo_parents_chase_ck";
ALTER TABLE "trade"."algo_parents" DROP COLUMN IF EXISTS "chase_start_price";
ALTER TABLE "trade"."algo_parents" DROP COLUMN IF EXISTS "chase_max_distance_bps";
