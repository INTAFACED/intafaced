-- Reverses 20261111122333_user_venue_agent_connections.sql.
DROP TRIGGER IF EXISTS user_venue_agent_connections_end_once_trg ON trade.user_venue_agent_connections;
DROP FUNCTION IF EXISTS trade.user_venue_agent_connections_end_once();
DROP TABLE IF EXISTS trade.user_venue_agent_connections;
