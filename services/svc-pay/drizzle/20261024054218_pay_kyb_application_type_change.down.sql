-- intafaced:destructive — reversal of 20261024054218_pay_kyb_application_type_change.sql
--
-- Drops the type-change record and the document boundary. type_changed events stay, so the narrower kind CHECK
-- comes back NOT VALID: it holds for every new row and leaves the old ones as they are (the table is append-only).

ALTER TABLE "pay"."kyb_application_events" DROP CONSTRAINT IF EXISTS "kyb_application_events_type_change_named";
ALTER TABLE "pay"."kyb_application_events" DROP CONSTRAINT IF EXISTS "kyb_application_events_kind_known";
ALTER TABLE "pay"."kyb_application_events"
  ADD CONSTRAINT "kyb_application_events_kind_known" CHECK ("kind" IN ('started', 'section_saved', 'restarted', 'submitted')) NOT VALID;
ALTER TABLE "pay"."kyb_application_events" DROP COLUMN IF EXISTS "country";
ALTER TABLE "pay"."kyb_application_events" DROP COLUMN IF EXISTS "entity_type";
ALTER TABLE "pay"."kyb_applications" DROP COLUMN IF EXISTS "documents_after_seq";
