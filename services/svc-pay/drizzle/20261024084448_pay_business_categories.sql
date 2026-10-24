-- BUSINESS CATEGORIES: WHICH BUSINESSES INTAFACED TAKES, AND ON WHAT TERMS (RC-merchant-08, J-merchant-02 step 7).
--
-- One versioned table the owner keeps. A category's class is permissionless, restricted or prohibited; only a
-- restricted category carries reserve terms (both blank, or both set) and extra verification documents. Every edit is
-- made by one founder and approved by a different one, bumps the category's version by one and appends an event; a
-- category is never deleted and its key never changes. The table version is the number of events. A business picks
-- one category; its choice is keyed to the table version it read, and every choice is an append-only event. A reserve
-- term is a policy value only. Not money.

CREATE TABLE IF NOT EXISTS "pay"."business_categories" (
  "key"               text PRIMARY KEY CONSTRAINT "business_categories_key_format" CHECK ("key" ~ '^[a-z][a-z0-9-]{1,62}$'),
  "label"             text NOT NULL CONSTRAINT "business_categories_label_len" CHECK (length(btrim("label")) BETWEEN 2 AND 120),
  "class"             text NOT NULL CONSTRAINT "business_categories_class_known" CHECK ("class" IN ('permissionless', 'restricted', 'prohibited')),
  "reserve_percent"   numeric(5, 2) CONSTRAINT "business_categories_reserve_range" CHECK ("reserve_percent" IS NULL OR ("reserve_percent" > 0 AND "reserve_percent" <= 100)),
  "reserve_hold_days" integer CONSTRAINT "business_categories_hold_range" CHECK ("reserve_hold_days" IS NULL OR "reserve_hold_days" BETWEEN 1 AND 3650),
  "extra_documents"   text[] NOT NULL DEFAULT '{}',
  "version"           integer NOT NULL CONSTRAINT "business_categories_version_positive" CHECK ("version" >= 1),
  "updated_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_by"        text NOT NULL CONSTRAINT "business_categories_actor_not_blank" CHECK (length(btrim("updated_by")) > 0),
  "approved_by"       text NOT NULL CONSTRAINT "business_categories_approver_not_blank" CHECK (length(btrim("approved_by")) > 0),
  CONSTRAINT "business_categories_two_people" CHECK (lower("updated_by") <> lower("approved_by")),
  CONSTRAINT "business_categories_reserve_whole" CHECK (("reserve_percent" IS NULL) = ("reserve_hold_days" IS NULL)),
  CONSTRAINT "business_categories_restricted_only" CHECK (
    "class" = 'restricted' OR ("reserve_percent" IS NULL AND cardinality("extra_documents") = 0)
  ),
  CONSTRAINT "business_categories_documents_count" CHECK (cardinality("extra_documents") <= 20)
);

CREATE TABLE IF NOT EXISTS "pay"."business_category_events" (
  "seq"         bigserial PRIMARY KEY,
  "key"         text NOT NULL REFERENCES "pay"."business_categories"("key"),
  "actor_id"    text NOT NULL CONSTRAINT "business_category_events_actor_not_blank" CHECK (length(btrim("actor_id")) > 0),
  "approver_id" text NOT NULL CONSTRAINT "business_category_events_approver_not_blank" CHECK (length(btrim("approver_id")) > 0),
  "before"      jsonb,
  "after"       jsonb NOT NULL,
  "reason"      text NOT NULL CONSTRAINT "business_category_events_reason_len" CHECK (length(btrim("reason")) BETWEEN 3 AND 500),
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "business_category_events_two_people" CHECK (lower("actor_id") <> lower("approver_id"))
);

CREATE INDEX IF NOT EXISTS "business_category_events_key_idx" ON "pay"."business_category_events" ("key", "seq" DESC);

CREATE TABLE IF NOT EXISTS "pay"."merchant_categories" (
  "merchant_id"   uuid PRIMARY KEY REFERENCES "pay"."merchants"("id"),
  "category_key"  text NOT NULL REFERENCES "pay"."business_categories"("key"),
  "table_version" bigint NOT NULL CONSTRAINT "merchant_categories_version_positive" CHECK ("table_version" >= 1),
  "chosen_by"     text NOT NULL CONSTRAINT "merchant_categories_actor_not_blank" CHECK (length(btrim("chosen_by")) > 0),
  "chosen_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "pay"."merchant_category_events" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id"   uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "category_key"  text NOT NULL REFERENCES "pay"."business_categories"("key"),
  "table_version" bigint NOT NULL,
  "actor_id"      text NOT NULL CONSTRAINT "merchant_category_events_actor_not_blank" CHECK (length(btrim("actor_id")) > 0),
  "created_at"    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "merchant_category_events_merchant_idx" ON "pay"."merchant_category_events" ("merchant_id", "created_at");

CREATE OR REPLACE FUNCTION "pay"."business_category_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay.% is append-only: % is not permitted.', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "business_category_events_append_only_trg" ON "pay"."business_category_events";
CREATE TRIGGER "business_category_events_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."business_category_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."business_category_append_only"();

DROP TRIGGER IF EXISTS "merchant_category_events_append_only_trg" ON "pay"."merchant_category_events";
CREATE TRIGGER "merchant_category_events_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."merchant_category_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."business_category_append_only"();

CREATE OR REPLACE FUNCTION "pay"."business_categories_versioned"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pay.business_categories rows are kept: DELETE is not permitted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."key" IS DISTINCT FROM OLD."key" OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'pay.business_categories: a category keeps its key and each edit raises its version by one.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "business_categories_versioned_trg" ON "pay"."business_categories";
CREATE TRIGGER "business_categories_versioned_trg"
  BEFORE UPDATE OR DELETE ON "pay"."business_categories"
  FOR EACH ROW EXECUTE FUNCTION "pay"."business_categories_versioned"();
