-- intafaced:destructive — reversal of 0102_pay_kyb_applications.sql
--
-- Drops the draft business applications, their saved sections and the event history. Stored rows go with the tables.

DROP TRIGGER IF EXISTS "kyb_application_events_append_only_trg" ON "pay"."kyb_application_events";
DROP FUNCTION IF EXISTS "pay"."kyb_application_events_append_only"();
DROP TABLE IF EXISTS "pay"."kyb_application_events";
DROP TABLE IF EXISTS "pay"."kyb_application_sections";
DROP TABLE IF EXISTS "pay"."kyb_applications";
