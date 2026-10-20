-- KYB APPLICATIONS: A BUSINESS FILLS IN ITS VERIFICATION A SECTION AT A TIME (I-kyc-compliance-21).
--
-- One draft per merchant. The required sections are fixed when the application starts, from the requirements the owner
-- had published for the entity type then, so a later change to the owner data cannot strand a draft. A submitted
-- application is not edited. Every start, save, restart and submit appends an event; nothing is overwritten there.
-- Not money.

CREATE TABLE IF NOT EXISTS "pay"."kyb_applications" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id"       uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "entity_type"       text NOT NULL,
  "country"           text NOT NULL CONSTRAINT "kyb_applications_country_format" CHECK ("country" ~ '^[A-Z]{2}$'),
  "required_sections" text[] NOT NULL
    CONSTRAINT "kyb_applications_required_sections_known" CHECK (
      cardinality("required_sections") >= 1
      AND "required_sections" <@ ARRAY['company_details', 'people', 'owners', 'documents', 'questionnaires']::text[]
    ),
  "state"             text NOT NULL DEFAULT 'draft' CONSTRAINT "kyb_applications_state_known" CHECK ("state" IN ('draft', 'submitted')),
  "kyb_ref"           text,
  "submitted_at"      timestamptz,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "kyb_applications_submitted_has_ref" CHECK (("state" = 'submitted') = ("kyb_ref" IS NOT NULL AND "submitted_at" IS NOT NULL))
);

-- At most one draft per merchant.
CREATE UNIQUE INDEX IF NOT EXISTS "kyb_applications_one_draft_idx"
  ON "pay"."kyb_applications" ("merchant_id") WHERE "state" = 'draft';

CREATE TABLE IF NOT EXISTS "pay"."kyb_application_sections" (
  "application_id" uuid NOT NULL REFERENCES "pay"."kyb_applications"("id"),
  "section"        text NOT NULL
    CONSTRAINT "kyb_application_sections_section_known" CHECK ("section" IN ('company_details', 'people', 'owners', 'documents', 'questionnaires')),
  "version"        integer NOT NULL CHECK ("version" >= 1),
  "complete"       boolean NOT NULL,
  "data"           jsonb NOT NULL CHECK (jsonb_typeof("data") = 'object'),
  "updated_at"     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("application_id", "section")
);

CREATE TABLE IF NOT EXISTS "pay"."kyb_application_events" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "seq"            bigserial NOT NULL,
  "application_id" uuid NOT NULL REFERENCES "pay"."kyb_applications"("id"),
  "kind"           text NOT NULL CONSTRAINT "kyb_application_events_kind_known" CHECK ("kind" IN ('started', 'section_saved', 'restarted', 'submitted')),
  "section"        text,
  "version"        integer,
  "actor_id"       text NOT NULL,
  "created_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "kyb_application_events_seq_idx" ON "pay"."kyb_application_events" ("seq");
CREATE INDEX IF NOT EXISTS "kyb_application_events_application_idx" ON "pay"."kyb_application_events" ("application_id", "seq" DESC);

CREATE OR REPLACE FUNCTION "pay"."kyb_application_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay.kyb_application_events is append-only: % is not permitted.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "kyb_application_events_append_only_trg" ON "pay"."kyb_application_events";
CREATE TRIGGER "kyb_application_events_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."kyb_application_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."kyb_application_events_append_only"();
