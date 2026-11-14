-- Reverses 20261114090000_user_venue_agent_desk_audit.sql.
DROP TRIGGER IF EXISTS user_venue_agent_desk_audit_append_only_trg ON trade.user_venue_agent_desk_audit;
DROP FUNCTION IF EXISTS trade.user_venue_agent_desk_audit_append_only();
DROP TABLE IF EXISTS trade.user_venue_agent_desk_audit;
