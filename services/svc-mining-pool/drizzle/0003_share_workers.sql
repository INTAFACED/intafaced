-- svc-mining-pool · shares name the worker that sent them; a worker may carry a minimum difficulty.
-- A share's miner_id stays the account the payout credits; worker_id only labels which rig sent it, so a worker is never
-- a payee. A share with no worker name goes to that account's "default" worker. One worker per (account, name).

ALTER TABLE "mining_pool"."workers" ADD COLUMN IF NOT EXISTS "min_difficulty" numeric(38, 0);
ALTER TABLE "mining_pool"."workers" DROP CONSTRAINT IF EXISTS "workers_min_difficulty_positive_ck";
ALTER TABLE "mining_pool"."workers"
  ADD CONSTRAINT "workers_min_difficulty_positive_ck" CHECK ("min_difficulty" IS NULL OR "min_difficulty" > 0);

CREATE UNIQUE INDEX IF NOT EXISTS "workers_user_name_uidx" ON "mining_pool"."workers" ("user_id", "name");

ALTER TABLE "mining_pool"."shares" ADD COLUMN IF NOT EXISTS "worker_id" text REFERENCES "mining_pool"."workers" ("id");

CREATE INDEX IF NOT EXISTS "shares_worker_created_idx"
  ON "mining_pool"."shares" ("worker_id", "created_at")
  WHERE "worker_id" IS NOT NULL;
