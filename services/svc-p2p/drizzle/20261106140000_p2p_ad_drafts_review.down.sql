-- Reverses 20261106140000_p2p_ad_drafts_review.sql. Drafts and ads waiting for review are closed by their maker (they
-- were never on the board and hold no order), then the status type goes back to active, paused and closed. The two
-- CHECKs that compare status to a literal are bound to the type, so they are dropped and put back around the change.
UPDATE "p2p"."offers" SET "status" = 'closed', "close_reason" = 'by_you' WHERE "status"::text IN ('draft', 'pending');
ALTER TABLE "p2p"."offers" DROP COLUMN IF EXISTS "listed";
DROP TRIGGER IF EXISTS "offers_status_since_trg" ON "p2p"."offers";
ALTER TABLE "p2p"."offers" DROP CONSTRAINT IF EXISTS "offers_close_reason_ck";
ALTER TABLE "p2p"."offers" DROP CONSTRAINT IF EXISTS "offers_pause_reason_ck";
ALTER TYPE "p2p"."offer_status" RENAME TO "offer_status_with_review";
CREATE TYPE "p2p"."offer_status" AS ENUM ('active', 'paused', 'closed');
ALTER TABLE "p2p"."offers" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "p2p"."offers" ALTER COLUMN "status" TYPE "p2p"."offer_status" USING "status"::text::"p2p"."offer_status";
ALTER TABLE "p2p"."offers" ALTER COLUMN "status" SET DEFAULT 'active';
DROP TYPE "p2p"."offer_status_with_review";
ALTER TABLE "p2p"."offers" ADD CONSTRAINT "offers_close_reason_ck"
  CHECK ("close_reason" IS NULL OR ("close_reason" IN ('by_you', 'sold_out') AND "status" = 'closed'));
ALTER TABLE "p2p"."offers" ADD CONSTRAINT "offers_pause_reason_ck"
  CHECK ("pause_reason" IS NULL OR ("pause_reason" = 'method_removed' AND "status" = 'paused'));
CREATE TRIGGER "offers_status_since_trg" BEFORE UPDATE OF "status" ON "p2p"."offers"
  FOR EACH ROW EXECUTE FUNCTION "p2p"."offers_status_since"();
