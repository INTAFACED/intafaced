-- intafaced:destructive — reversal of 0001_listing_overrides.sql
--
-- This drops the hide and delist decisions, so every hidden pool and delisted market would list again and the signed
-- decision log would be gone. The guard refuses to roll back while any decision exists: archive them first.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "protocol"."listing_decisions") THEN
    RAISE EXCEPTION 'listing decisions exist; archive them before rolling back, or hidden pools will list again';
  END IF;
END
$$;

DROP INDEX IF EXISTS "protocol"."listing_decisions_target_idx";
DROP TABLE IF EXISTS "protocol"."listing_decisions";
DROP TABLE IF EXISTS "protocol"."listing_overrides";
