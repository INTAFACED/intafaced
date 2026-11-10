-- Reverses 20261109140659_venue_listings.sql. Destructive: every venue listing, routing state, routed-order limit and
-- delisting notice row is lost, and with no listing the user-venue door shows no market. Run only on a database whose
-- rows may go.
DROP TRIGGER IF EXISTS venue_delisting_notices_publish_once_trg ON trade.venue_delisting_notices;
DROP FUNCTION IF EXISTS trade.venue_delisting_notices_publish_once();
DROP TRIGGER IF EXISTS venue_routed_limits_append_only_trg ON trade.venue_routed_limits;
DROP TRIGGER IF EXISTS venue_listings_append_only_trg ON trade.venue_listings;
DROP FUNCTION IF EXISTS trade.venue_listing_versions_append_only();
DROP TABLE IF EXISTS trade.venue_delisting_notices;
DROP TABLE IF EXISTS trade.venue_routed_limits;
DROP TABLE IF EXISTS trade.venue_listings;
