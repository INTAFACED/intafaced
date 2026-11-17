-- Reverses 20261112090000_user_venue_engine_protections.sql.
DROP TRIGGER IF EXISTS user_venue_engine_protections_once_trg ON trade.user_venue_engine_protections;
DROP FUNCTION IF EXISTS trade.user_venue_engine_protections_once();
DROP TABLE IF EXISTS trade.user_venue_engine_protections;
