-- intafaced:destructive — reversal of 0004_pow_solo.sql
ALTER TABLE "mining_pool"."workers" DROP CONSTRAINT IF EXISTS "workers_mode_ck";
ALTER TABLE "mining_pool"."workers" DROP COLUMN IF EXISTS "mode";
DROP INDEX IF EXISTS "mining_pool"."shares_window_worker_nonce_uidx";
ALTER TABLE "mining_pool"."shares" DROP COLUMN IF EXISTS "solo";
ALTER TABLE "mining_pool"."shares" DROP COLUMN IF EXISTS "pow_nonce";
