-- intafaced:destructive — reversal of 20261024080000_console_mode.sql
--
-- Lossy by nature: the console mode and its change log are dropped. With the row gone the console reads as writable.
DROP TRIGGER IF EXISTS console_mode_log_append_only ON ops.console_mode_log;
DROP FUNCTION IF EXISTS ops.console_mode_log_append_only();
DROP TABLE IF EXISTS ops.console_mode_log;
DROP TABLE IF EXISTS ops.console_mode;
