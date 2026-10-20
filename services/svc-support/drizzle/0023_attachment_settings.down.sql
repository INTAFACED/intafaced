-- Reverse 0023_attachment_settings.sql
-- Lossy by nature: the limits and their log are dropped.

DROP TRIGGER IF EXISTS "attachment_settings_log_append_only_trg" ON "support"."attachment_settings_log";
DROP FUNCTION IF EXISTS "support"."attachment_settings_log_append_only"();
DROP TABLE IF EXISTS "support"."attachment_settings_log";
DROP TABLE IF EXISTS "support"."attachment_settings";
