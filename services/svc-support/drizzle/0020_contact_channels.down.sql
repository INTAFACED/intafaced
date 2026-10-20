-- Reverse 0020_contact_channels.sql
-- Lossy by nature: the contact details and their log are dropped.

DROP TRIGGER IF EXISTS "contact_channel_log_append_only_trg" ON "support"."contact_channel_log";
DROP FUNCTION IF EXISTS "support"."contact_channel_log_append_only"();
DROP TABLE IF EXISTS "support"."contact_channel_log";
DROP TABLE IF EXISTS "support"."contact_channels";
