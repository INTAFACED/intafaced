-- intafaced:destructive — reversal of 0003_share_workers.sql
DROP INDEX IF EXISTS "mining_pool"."shares_worker_created_idx";
ALTER TABLE "mining_pool"."shares" DROP COLUMN IF EXISTS "worker_id";
DROP INDEX IF EXISTS "mining_pool"."workers_user_name_uidx";
ALTER TABLE "mining_pool"."workers" DROP CONSTRAINT IF EXISTS "workers_min_difficulty_positive_ck";
ALTER TABLE "mining_pool"."workers" DROP COLUMN IF EXISTS "min_difficulty";
