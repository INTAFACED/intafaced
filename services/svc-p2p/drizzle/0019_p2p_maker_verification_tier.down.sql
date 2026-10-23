-- Reverse 0019. Drops the maker tier stored at create.
ALTER TABLE "p2p"."offers" DROP CONSTRAINT IF EXISTS "offers_maker_tier_ck";
ALTER TABLE "p2p"."offers" DROP COLUMN IF EXISTS "maker_tier";
