-- intafaced:destructive — reversal of 20261024100000_console_announcements.sql
--
-- Lossy by nature: the console's announcements, staff preferences and their logs are dropped. With them gone no banner
-- shows and every preference reads as the server's.
DROP TRIGGER IF EXISTS console_preference_log_append_only ON ops.console_preference_log;
DROP TRIGGER IF EXISTS console_announcement_log_append_only ON ops.console_announcement_log;
DROP FUNCTION IF EXISTS ops.console_log_append_only();
DROP TABLE IF EXISTS ops.console_preference_log;
DROP TABLE IF EXISTS ops.console_preferences;
DROP TABLE IF EXISTS ops.console_announcement_log;
DROP TABLE IF EXISTS ops.console_announcements;
