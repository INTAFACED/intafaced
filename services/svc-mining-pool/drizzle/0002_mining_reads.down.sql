-- intafaced:destructive — reversal of 0002_mining_reads.sql
DROP TABLE IF EXISTS "mining_pool"."share_rejections";
DROP TABLE IF EXISTS "mining_pool"."workers";
ALTER TABLE "mining_pool"."windows" DROP COLUMN IF EXISTS "paid_at";
