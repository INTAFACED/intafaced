-- KYB APPLICATION: CHANGING THE ENTITY TYPE, AND DOCUMENTS THAT A RESTART CLEARS (J-merchant-02 steps 2 and 3).
--
-- A business can change its entity type (or country) while its application is a draft. The change clears every
-- section, fixes the required sections again from what the owner publishes for the new type, and is recorded as a
-- `type_changed` event naming the new type and country. `documents_after_seq` is the newest document sequence number
-- at the last restart or type change: uploads at or below it no longer count, so a cleared application asks for its
-- documents again. The uploads themselves are kept. Not money.
--
-- intafaced:destructive replaces the event kind CHECK with a wider one; every existing kind stays allowed.

ALTER TABLE "pay"."kyb_applications"
  ADD COLUMN IF NOT EXISTS "documents_after_seq" bigint NOT NULL DEFAULT 0
    CONSTRAINT "kyb_applications_documents_after_seq_ck" CHECK ("documents_after_seq" >= 0);

ALTER TABLE "pay"."kyb_application_events" ADD COLUMN IF NOT EXISTS "entity_type" text;
ALTER TABLE "pay"."kyb_application_events" ADD COLUMN IF NOT EXISTS "country" text;

ALTER TABLE "pay"."kyb_application_events" DROP CONSTRAINT IF EXISTS "kyb_application_events_kind_known";
ALTER TABLE "pay"."kyb_application_events"
  ADD CONSTRAINT "kyb_application_events_kind_known" CHECK ("kind" IN ('started', 'section_saved', 'restarted', 'submitted', 'type_changed'));

ALTER TABLE "pay"."kyb_application_events" DROP CONSTRAINT IF EXISTS "kyb_application_events_type_change_named";
ALTER TABLE "pay"."kyb_application_events"
  ADD CONSTRAINT "kyb_application_events_type_change_named" CHECK (
    ("kind" = 'type_changed') = ("entity_type" IS NOT NULL AND "country" IS NOT NULL)
  );
