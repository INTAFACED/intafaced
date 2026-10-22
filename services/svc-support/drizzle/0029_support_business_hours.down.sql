-- Reverse 0029_support_business_hours.sql
-- Lossy: the hours, their change log and the record of which requests got the out-of-hours reply are dropped.
DROP TABLE IF EXISTS "support"."out_of_hours_replies";
DROP TRIGGER IF EXISTS "business_hours_log_append_only_trg" ON "support"."business_hours_log";
DROP FUNCTION IF EXISTS "support"."business_hours_log_append_only"();
DROP TABLE IF EXISTS "support"."business_hours_log";
DROP TABLE IF EXISTS "support"."business_hours";
