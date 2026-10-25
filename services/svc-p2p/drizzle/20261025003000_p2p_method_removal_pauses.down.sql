-- Reverses 20261025003000_p2p_method_removal_pauses.sql. Ads paused for a removed method stay paused, without a reason.
DROP TABLE IF EXISTS "p2p"."method_removal_pauses";
ALTER TABLE "p2p"."offers" DROP CONSTRAINT IF EXISTS "offers_pause_reason_ck";
ALTER TABLE "p2p"."offers" DROP COLUMN IF EXISTS "pause_reason";
