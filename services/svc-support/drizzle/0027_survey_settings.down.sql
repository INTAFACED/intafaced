-- Reverse 0027_survey_settings.sql
-- Lossy by nature: the surveys and their log are dropped.

DROP TRIGGER IF EXISTS "survey_log_append_only_trg" ON "support"."survey_log";
DROP FUNCTION IF EXISTS "support"."survey_log_append_only"();
DROP TABLE IF EXISTS "support"."survey_log";
DROP TABLE IF EXISTS "support"."surveys";
