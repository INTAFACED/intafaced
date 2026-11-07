-- Reverses 20261106140000_p2p_ad_drafts_review.sql. Drafts and ads waiting for review are closed by their maker (they
-- were never on the board and hold no order), then the status type goes back to active, paused and closed. The two
-- CHECKs that compare status to a literal are bound to the type, so they are dropped and put back around the change.
-- Safe to run again: it acts only while the status type still has 'draft' (this migration in effect), and it puts back
-- only the CHECKs and trigger whose columns and function are still there (an older reversal may have removed them).
ALTER TABLE "p2p"."offers" DROP COLUMN IF EXISTS "listed";
DO $$
DECLARE
  has_close boolean := EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'p2p' AND table_name = 'offers' AND column_name = 'close_reason'
  );
  has_pause boolean := EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'p2p' AND table_name = 'offers' AND column_name = 'pause_reason'
  );
  has_since boolean := to_regprocedure('p2p.offers_status_since()') IS NOT NULL;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'p2p' AND t.typname = 'offer_status' AND e.enumlabel = 'draft'
  ) THEN
    RETURN;
  END IF;
  IF has_close THEN
    UPDATE "p2p"."offers" SET "status" = 'closed', "close_reason" = 'by_you' WHERE "status"::text IN ('draft', 'pending');
  ELSE
    UPDATE "p2p"."offers" SET "status" = 'closed' WHERE "status"::text IN ('draft', 'pending');
  END IF;
  DROP TRIGGER IF EXISTS "offers_status_since_trg" ON "p2p"."offers";
  ALTER TABLE "p2p"."offers" DROP CONSTRAINT IF EXISTS "offers_close_reason_ck";
  ALTER TABLE "p2p"."offers" DROP CONSTRAINT IF EXISTS "offers_pause_reason_ck";
  ALTER TYPE "p2p"."offer_status" RENAME TO "offer_status_with_review";
  CREATE TYPE "p2p"."offer_status" AS ENUM ('active', 'paused', 'closed');
  ALTER TABLE "p2p"."offers" ALTER COLUMN "status" DROP DEFAULT;
  ALTER TABLE "p2p"."offers" ALTER COLUMN "status" TYPE "p2p"."offer_status" USING "status"::text::"p2p"."offer_status";
  ALTER TABLE "p2p"."offers" ALTER COLUMN "status" SET DEFAULT 'active';
  DROP TYPE "p2p"."offer_status_with_review";
  IF has_close THEN
    ALTER TABLE "p2p"."offers" ADD CONSTRAINT "offers_close_reason_ck"
      CHECK ("close_reason" IS NULL OR ("close_reason" IN ('by_you', 'sold_out') AND "status" = 'closed'));
  END IF;
  IF has_pause THEN
    ALTER TABLE "p2p"."offers" ADD CONSTRAINT "offers_pause_reason_ck"
      CHECK ("pause_reason" IS NULL OR ("pause_reason" = 'method_removed' AND "status" = 'paused'));
  END IF;
  IF has_since THEN
    CREATE TRIGGER "offers_status_since_trg" BEFORE UPDATE OF "status" ON "p2p"."offers"
      FOR EACH ROW EXECUTE FUNCTION "p2p"."offers_status_since"();
  END IF;
END $$;
