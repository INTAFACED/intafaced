-- intafaced:destructive — reversal of 0011_protocol_listing.sql
--
-- This drops the hide and delist decisions, so every hidden pool and delisted market would list again and the signed
-- decision log would be gone. The guard refuses to roll back while any decision exists: archive them first.
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM ops.protocol_listing_decisions) THEN
  RAISE EXCEPTION 'protocol listing decisions exist; archive them before rolling back, or hidden pools will list again';
 END IF;
END
$$;
DROP TRIGGER protocol_listing_decisions_append_only ON ops.protocol_listing_decisions;
DROP FUNCTION ops.protocol_listing_decisions_append_only();
DROP TABLE ops.protocol_listing_decisions;
DROP TABLE ops.protocol_listing_overrides;
