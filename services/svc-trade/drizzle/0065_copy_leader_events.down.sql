-- Reverse 0065_copy_leader_events.sql
DROP TRIGGER IF EXISTS copy_leader_events_append_only ON trade.copy_leader_events;
DROP TABLE IF EXISTS trade.copy_leader_events;
