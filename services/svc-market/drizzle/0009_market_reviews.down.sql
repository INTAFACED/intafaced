-- Reverse 0009_market_reviews.sql
-- A published review is the buyer's record. Do not discard it.

LOCK TABLE "market"."reviews" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "market"."reviews") THEN
    RAISE EXCEPTION 'market.reviews_downgrade_refused: known reviews cannot be discarded'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

DROP TABLE IF EXISTS "market"."reviews";
