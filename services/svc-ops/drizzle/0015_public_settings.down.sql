-- intafaced:destructive — reversal of 0015_public_settings.sql
--
-- Lossy by nature: the join address, the partner terms and their change log are dropped.
DROP TRIGGER IF EXISTS public_settings_log_append_only ON ops.public_settings_log;
DROP FUNCTION IF EXISTS ops.public_settings_log_append_only();
DROP TABLE IF EXISTS ops.public_settings_log;
DROP TABLE IF EXISTS ops.public_settings;
