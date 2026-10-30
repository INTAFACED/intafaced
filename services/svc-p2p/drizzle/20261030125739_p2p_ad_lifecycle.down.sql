-- Reverses 20261030125739_p2p_ad_lifecycle.sql. Ads keep their status; why they were closed, since when, which closed
-- ad a relisted one came from and the count of edits are dropped.
DROP TABLE IF EXISTS "p2p"."offer_edits";
DROP INDEX IF EXISTS "p2p"."offers_relisted_from_uq";
ALTER TABLE "p2p"."offers" DROP COLUMN IF EXISTS "relisted_from";
DROP TRIGGER IF EXISTS "offers_status_since_trg" ON "p2p"."offers";
DROP FUNCTION IF EXISTS "p2p"."offers_status_since"();
ALTER TABLE "p2p"."offers" DROP COLUMN IF EXISTS "status_since";
ALTER TABLE "p2p"."offers" DROP CONSTRAINT IF EXISTS "offers_close_reason_ck";
ALTER TABLE "p2p"."offers" DROP COLUMN IF EXISTS "close_reason";
