-- Reverses 20261123124904_user_venue_auto_top_up.sql.
DROP TRIGGER IF EXISTS user_venue_auto_top_up_adds_once_trg ON trade.user_venue_auto_top_up_adds;
DROP FUNCTION IF EXISTS trade.user_venue_auto_top_up_adds_once();
DROP TABLE IF EXISTS trade.user_venue_auto_top_up_adds;
DROP TABLE IF EXISTS trade.user_venue_auto_top_ups;
DROP TABLE IF EXISTS trade.user_venue_auto_top_up_permissions;
