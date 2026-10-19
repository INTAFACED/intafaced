-- Reversal of 0067_copy_mirror_events.sql
DROP TRIGGER IF EXISTS copy_mirror_events_append_only ON trade.copy_mirror_events;
DROP TABLE IF EXISTS trade.copy_mirror_events;
DROP FUNCTION IF EXISTS trade.copy_mirror_events_append_only();
