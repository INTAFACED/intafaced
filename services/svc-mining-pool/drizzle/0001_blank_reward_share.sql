-- intafaced:destructive — allow empty unpublished terms; preserve positive checks and all existing data.
-- Unpublished payout terms stay empty; existing positive checks reject zero.
-- Forward upgrade: preserve every existing reward, fee, epoch and weight.
ALTER TABLE "mining_pool"."windows" ALTER COLUMN "reward" DROP NOT NULL;
ALTER TABLE "mining_pool"."windows" ALTER COLUMN "fee_bps" DROP NOT NULL;
ALTER TABLE "mining_pool"."shares" ALTER COLUMN "weight" DROP NOT NULL;
