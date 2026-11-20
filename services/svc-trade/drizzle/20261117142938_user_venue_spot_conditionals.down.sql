-- Reverses 20261117142938_user_venue_spot_conditionals.sql.
DROP TRIGGER IF EXISTS user_venue_spot_conditionals_once_trg ON trade.user_venue_spot_conditionals;
DROP FUNCTION IF EXISTS trade.user_venue_spot_conditionals_once();
DROP TABLE IF EXISTS trade.user_venue_spot_conditionals;
