-- Reverses 20261112022349_user_venue_own_agent_allowances.sql.
DROP TRIGGER IF EXISTS user_venue_own_agent_draws_settle_once_trg ON trade.user_venue_own_agent_draws;
DROP FUNCTION IF EXISTS trade.user_venue_own_agent_draws_settle_once();
DROP TABLE IF EXISTS trade.user_venue_own_agent_draws;
DROP TABLE IF EXISTS trade.user_venue_own_agent_allowances;
