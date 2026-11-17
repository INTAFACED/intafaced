-- Reverses 20261115150000_user_venue_own_agent_rebalances.sql.
DROP TRIGGER IF EXISTS user_venue_own_agent_rebalances_decide_once_trg ON trade.user_venue_own_agent_rebalances;
DROP FUNCTION IF EXISTS trade.user_venue_own_agent_rebalances_decide_once();
DROP TABLE IF EXISTS trade.user_venue_own_agent_rebalances;
