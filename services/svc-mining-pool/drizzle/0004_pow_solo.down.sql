-- intafaced:destructive — reversal of 0004_pow_solo.sql
ALTER TABLE "mining_pool"."workers" DROP CONSTRAINT IF EXISTS "workers_mode_ck";
ALTER TABLE "mining_pool"."workers" DROP COLUMN IF EXISTS "mode";
DROP INDEX IF EXISTS "mining_pool"."shares_window_worker_nonce_uidx";
ALTER TABLE "mining_pool"."shares" DROP COLUMN IF EXISTS "solo";
ALTER TABLE "mining_pool"."shares" DROP COLUMN IF EXISTS "testnet";
-- A window closed with no credit paid nothing; it goes back to open, as it was before 0004.
ALTER TABLE "mining_pool"."windows" DROP CONSTRAINT IF EXISTS "windows_status_ck";
UPDATE "mining_pool"."windows" SET "status" = 'open' WHERE "status" = 'no_credit';
ALTER TABLE "mining_pool"."windows" ADD CONSTRAINT "windows_status_ck" CHECK ("status" IN ('open', 'paid'));
ALTER TABLE "mining_pool"."shares" DROP COLUMN IF EXISTS "pow_nonce";
