-- Reverse 0008_market_listing_takedown.sql
-- A taken-down listing is an operator decision. Do not discard it to make
-- the old status check fit. The runner holds this transaction through its
-- tracking-row delete.

LOCK TABLE "market"."listings" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "market"."listing_takedowns" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "market"."listings"
     WHERE "status" = 'taken_down'
        OR "taken_down_at" IS NOT NULL
        OR "taken_down_reason" IS NOT NULL
        OR "taken_down_actor_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'market.listing_takedown_downgrade_refused: known takedowns cannot be discarded'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "market"."listing_takedowns") THEN
    RAISE EXCEPTION 'market.listing_takedown_downgrade_refused: known takedown commands cannot be discarded'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

DROP TABLE IF EXISTS "market"."listing_takedowns";

DROP TRIGGER IF EXISTS "listings_taken_down_terminal_trg" ON "market"."listings";
DROP FUNCTION IF EXISTS "market"."listings_taken_down_terminal"();

ALTER TABLE "market"."listings" DROP CONSTRAINT IF EXISTS "listings_taken_down_audit_ck";
ALTER TABLE "market"."listings" DROP COLUMN IF EXISTS "taken_down_reason";
ALTER TABLE "market"."listings" DROP COLUMN IF EXISTS "taken_down_actor_id";
ALTER TABLE "market"."listings" DROP COLUMN IF EXISTS "taken_down_at";

ALTER TABLE "market"."listings" DROP CONSTRAINT IF EXISTS "listings_status_ck";
ALTER TABLE "market"."listings"
  ADD CONSTRAINT "listings_status_ck" CHECK ("status" IN ('active', 'archived'));
