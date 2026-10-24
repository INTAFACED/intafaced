-- svc-support · the help library: categories, sections and articles typed in the desk (SP-kb-01)
-- Reversal: 0032_kb_library.down.sql
--
-- NOT tagged `intafaced:destructive`: it adds columns and tables. Every existing version keeps its
-- catalogue keys and reads exactly as before; only a version written by the desk carries text.
--
-- The text lives on the immutable version row, like the topic (0011) and the audience (0022): a new
-- title or body is a new version. Categories and sections are created by support staff, never seeded;
-- retiring one takes it off the reader's list and deletes nothing. Each change is logged with its reason.

ALTER TABLE "support"."kb_article_versions" ADD COLUMN IF NOT EXISTS "title" text;
ALTER TABLE "support"."kb_article_versions" ADD COLUMN IF NOT EXISTS "body" text;
ALTER TABLE "support"."kb_article_versions" ADD COLUMN IF NOT EXISTS "language" text;
ALTER TABLE "support"."kb_article_versions" ADD COLUMN IF NOT EXISTS "section_id" text;

ALTER TABLE "support"."kb_article_versions" DROP CONSTRAINT IF EXISTS "kb_article_versions_text_ck";
ALTER TABLE "support"."kb_article_versions" ADD CONSTRAINT "kb_article_versions_text_ck"
  CHECK (
    ("title" IS NULL AND "body" IS NULL AND "language" IS NULL)
    OR (
      "title" IS NOT NULL AND "body" IS NOT NULL AND "language" IS NOT NULL
      AND char_length(btrim("title")) BETWEEN 1 AND 200
      AND char_length(btrim("body")) BETWEEN 1 AND 20000
      AND "language" ~ '^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$'
    )
  );

CREATE TABLE IF NOT EXISTS "support"."kb_categories" (
  "id" text PRIMARY KEY CHECK ("id" ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  "name" text NOT NULL CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
  "position" integer NOT NULL CHECK ("position" BETWEEN 0 AND 10000),
  "retired" boolean NOT NULL DEFAULT false,
  "updated_by" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "support"."kb_sections" (
  "id" text PRIMARY KEY CHECK ("id" ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  "category_id" text NOT NULL REFERENCES "support"."kb_categories" ("id"),
  "name" text NOT NULL CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
  "position" integer NOT NULL CHECK ("position" BETWEEN 0 AND 10000),
  "retired" boolean NOT NULL DEFAULT false,
  "updated_by" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "kb_sections_category_idx" ON "support"."kb_sections" ("category_id");

-- A version filed under a section names one that exists. Sections are never deleted, so the history stays readable.
ALTER TABLE "support"."kb_article_versions" DROP CONSTRAINT IF EXISTS "kb_article_versions_section_fk";
ALTER TABLE "support"."kb_article_versions" ADD CONSTRAINT "kb_article_versions_section_fk"
  FOREIGN KEY ("section_id") REFERENCES "support"."kb_sections" ("id");

CREATE TABLE IF NOT EXISTS "support"."kb_library_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" text NOT NULL CHECK ("kind" IN ('category', 'section')),
  "target_id" text NOT NULL,
  "before" jsonb,
  "after" jsonb NOT NULL,
  "actor_id" text NOT NULL,
  "reason" text NOT NULL CHECK (char_length(btrim("reason")) BETWEEN 1 AND 500),
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION "support"."kb_library_log_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'support.kb_library_log is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "kb_library_log_append_only_trg" ON "support"."kb_library_log";
CREATE TRIGGER "kb_library_log_append_only_trg"
  BEFORE UPDATE OR DELETE ON "support"."kb_library_log"
  FOR EACH ROW EXECUTE FUNCTION "support"."kb_library_log_append_only"();
