-- Reverses 20261106140000_p2p_ad_drafts_review.sql. Drafts and ads waiting for review are closed by their maker (they
-- were never on the board and hold no order), then the status type goes back to active, paused and closed.
UPDATE "p2p"."offers" SET "status" = 'closed', "close_reason" = 'by_you' WHERE "status"::text IN ('draft', 'pending');
DROP TRIGGER IF EXISTS "offers_status_since_trg" ON "p2p"."offers";
ALTER TYPE "p2p"."offer_status" RENAME TO "offer_status_with_review";
CREATE TYPE "p2p"."offer_status" AS ENUM ('active', 'paused', 'closed');
ALTER TABLE "p2p"."offers" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "p2p"."offers" ALTER COLUMN "status" TYPE "p2p"."offer_status" USING "status"::text::"p2p"."offer_status";
ALTER TABLE "p2p"."offers" ALTER COLUMN "status" SET DEFAULT 'active';
DROP TYPE "p2p"."offer_status_with_review";
CREATE TRIGGER "offers_status_since_trg" BEFORE UPDATE OF "status" ON "p2p"."offers"
  FOR EACH ROW EXECUTE FUNCTION "p2p"."offers_status_since"();
