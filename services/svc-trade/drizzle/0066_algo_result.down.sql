-- intafaced:destructive — reversal of 0066_algo_result.sql
DROP TABLE IF EXISTS "trade"."algo_scheduler_heartbeat";
ALTER TABLE "trade"."algo_parents" DROP COLUMN IF EXISTS "arrival_mark_at";
ALTER TABLE "trade"."algo_parents" DROP COLUMN IF EXISTS "arrival_mark";
