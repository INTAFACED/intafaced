-- Refuse reversal while empty slots exist. Never invent terms or delete shares.
ALTER TABLE "mining_pool"."windows" ALTER COLUMN "reward" SET NOT NULL;
ALTER TABLE "mining_pool"."windows" ALTER COLUMN "fee_bps" SET NOT NULL;
ALTER TABLE "mining_pool"."shares" ALTER COLUMN "weight" SET NOT NULL;
