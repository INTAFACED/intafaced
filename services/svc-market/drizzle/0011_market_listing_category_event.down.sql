-- Reverse 0011_market_listing_category_event.sql
DROP TRIGGER IF EXISTS "listing_category_events_append_only_trg" ON "market"."listing_category_events";
DROP TABLE IF EXISTS "market"."listing_category_events";
DROP FUNCTION IF EXISTS "market"."listing_category_events_append_only"();
