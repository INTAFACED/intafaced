-- Reverse 20261029160000_algo_random_trigger.sql
ALTER TABLE "trade"."algo_parents" DROP CONSTRAINT IF EXISTS "algo_parents_random_trigger_ck";
ALTER TABLE "trade"."algo_parents" DROP COLUMN IF EXISTS "triggered_at";
ALTER TABLE "trade"."algo_parents" DROP COLUMN IF EXISTS "trigger_above";
ALTER TABLE "trade"."algo_parents" DROP COLUMN IF EXISTS "trigger_price";
ALTER TABLE "trade"."algo_parents" DROP COLUMN IF EXISTS "random_seed";
