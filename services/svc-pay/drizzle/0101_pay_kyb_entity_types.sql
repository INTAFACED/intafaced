-- KYB ENTITY TYPES: WHAT EACH TYPE OF BUSINESS HAS TO PROVIDE (I-kyc-compliance-20).
--
-- Owner data. One row is one published entity type: the documents, people roles and questionnaires the owner
-- requires for it, and the countries it is offered in. A type with no row is not offered, and nothing here is a
-- default: the table starts empty. The service only reads it. Unpublish by deleting the row.
-- Not money.

CREATE OR REPLACE FUNCTION "pay"."kyb_all_match"(items text[], re text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(bool_and(item ~ re), true) FROM unnest(items) AS item
$$;

CREATE TABLE IF NOT EXISTS "pay"."kyb_entity_types" (
  "entity_type"        text PRIMARY KEY NOT NULL
    CONSTRAINT "kyb_entity_types_type_known" CHECK ("entity_type" IN (
      'private_company', 'listed_company', 'financial_institution', 'fund', 'trust',
      'non_profit', 'government_owned', 'family_office', 'partnership', 'sole_proprietorship'
    )),
  "document_keys"      text[] NOT NULL DEFAULT '{}'
    CONSTRAINT "kyb_entity_types_document_keys_format" CHECK ("pay"."kyb_all_match"("document_keys", '^[a-z][a-z0-9_]{1,63}$')),
  "people_roles"       text[] NOT NULL DEFAULT '{}'
    CONSTRAINT "kyb_entity_types_people_roles_format" CHECK ("pay"."kyb_all_match"("people_roles", '^[a-z][a-z0-9_]{1,63}$')),
  "questionnaire_keys" text[] NOT NULL DEFAULT '{}'
    CONSTRAINT "kyb_entity_types_questionnaire_keys_format" CHECK ("pay"."kyb_all_match"("questionnaire_keys", '^[a-z][a-z0-9_]{1,63}$')),
  "countries"          text[] NOT NULL
    CONSTRAINT "kyb_entity_types_countries_format" CHECK (cardinality("countries") >= 1 AND "pay"."kyb_all_match"("countries", '^[A-Z]{2}$')),
  "created_at"         timestamptz NOT NULL DEFAULT now(),
  "updated_at"         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "kyb_entity_types_requirements_published" CHECK (
    cardinality("document_keys") + cardinality("people_roles") + cardinality("questionnaire_keys") >= 1
  )
);
