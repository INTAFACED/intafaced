-- Reverses 20261112150000_copy_venue_follows.sql.
DROP TRIGGER IF EXISTS copy_venue_follows_fixed_trg ON trade.copy_venue_follows;
DROP FUNCTION IF EXISTS trade.copy_venue_follows_fixed();
DROP TABLE IF EXISTS trade.copy_venue_follows;
