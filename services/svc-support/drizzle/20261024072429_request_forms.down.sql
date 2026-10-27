-- Reverse 20261024072429_request_forms.sql
-- intafaced:destructive drops request form definitions, their log and the answers requests were sent with
-- Lossy by nature: the definitions, their log and the answers kept beside requests are dropped.

DROP TABLE IF EXISTS "support"."ticket_field_values";
DROP TRIGGER IF EXISTS "request_definition_log_append_only_trg" ON "support"."request_definition_log";
DROP FUNCTION IF EXISTS "support"."request_definition_log_append_only"();
DROP TABLE IF EXISTS "support"."request_definition_log";
DROP TABLE IF EXISTS "support"."request_definitions";
