-- Reverse 0030_help_centre.sql
-- Lossy by nature: the help centre settings, translation states and their logs are dropped.

DROP TRIGGER IF EXISTS "help_centre_translation_log_append_only_trg" ON "support"."help_centre_translation_log";
DROP FUNCTION IF EXISTS "support"."help_centre_translation_log_append_only"();
DROP TABLE IF EXISTS "support"."help_centre_translation_log";
DROP TABLE IF EXISTS "support"."help_centre_translation";

DROP TRIGGER IF EXISTS "help_centre_languages_ok_trg" ON "support"."help_centre";
DROP TRIGGER IF EXISTS "help_centre_log_append_only_trg" ON "support"."help_centre_log";
DROP FUNCTION IF EXISTS "support"."help_centre_languages_ok"();
DROP FUNCTION IF EXISTS "support"."help_centre_log_append_only"();
DROP TABLE IF EXISTS "support"."help_centre_log";
DROP TABLE IF EXISTS "support"."help_centre";
