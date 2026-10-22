-- svc-support · help-centre authoring: categories, sections, drafts and desk-written article versions (SP-kb-01)
-- Reversal: 0030_kb_authoring.down.sql
--
-- Create-only. Nothing is seeded: categories and sections are owner content, and an article with no section sits in
-- the one default section. The keyed spine (kb_articles / kb_article_versions, 0003-0022) is not touched.
-- A published version is immutable (update and delete refused) and carries its publish key
-- `support.kb.publish:<article>:r<revision>`, unique, so a replayed publish can never write a second version.

CREATE TABLE IF NOT EXISTS "support"."kb_categories" (
  "id" uuid PRIMARY KEY,
  "name" text NOT NULL CHECK (char_length("name") BETWEEN 1 AND 120),
  "position" integer NOT NULL CHECK ("position" >= 0),
  "parent_id" uuid REFERENCES "support"."kb_categories" ("id") ON DELETE RESTRICT,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CHECK ("parent_id" IS NULL OR "parent_id" <> "id")
);

CREATE TABLE IF NOT EXISTS "support"."kb_sections" (
  "id" uuid PRIMARY KEY,
  "category_id" uuid NOT NULL REFERENCES "support"."kb_categories" ("id") ON DELETE RESTRICT,
  "name" text NOT NULL CHECK (char_length("name") BETWEEN 1 AND 120),
  "position" integer NOT NULL CHECK ("position" >= 0),
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "support"."kb_authored_articles" (
  "id" uuid PRIMARY KEY,
  "revision" integer NOT NULL CHECK ("revision" >= 1),
  "updated_at" timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "support"."kb_authored_versions" (
  "article_id" uuid NOT NULL REFERENCES "support"."kb_authored_articles" ("id") ON DELETE RESTRICT,
  "version" integer NOT NULL CHECK ("version" >= 1),
  "publish_key" text NOT NULL UNIQUE,
  "language" text NOT NULL,
  "title" text NOT NULL CHECK (char_length("title") BETWEEN 1 AND 200),
  "body" text NOT NULL CHECK (char_length("body") BETWEEN 1 AND 20000),
  "section_id" uuid REFERENCES "support"."kb_sections" ("id") ON DELETE RESTRICT,
  "published_by" text NOT NULL,
  "published_at" timestamptz NOT NULL,
  PRIMARY KEY ("article_id", "version")
);

CREATE OR REPLACE FUNCTION "support"."kb_authored_versions_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'support.kb_authored_versions is immutable' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "kb_authored_versions_immutable_trg" ON "support"."kb_authored_versions";
CREATE TRIGGER "kb_authored_versions_immutable_trg"
  BEFORE UPDATE OR DELETE ON "support"."kb_authored_versions"
  FOR EACH ROW EXECUTE FUNCTION "support"."kb_authored_versions_immutable"();

CREATE TABLE IF NOT EXISTS "support"."kb_drafts" (
  "article_id" uuid PRIMARY KEY,
  "language" text NOT NULL,
  "title" text NOT NULL CHECK (char_length("title") BETWEEN 1 AND 200),
  "body" text NOT NULL CHECK (char_length("body") BETWEEN 1 AND 20000),
  "section_id" uuid REFERENCES "support"."kb_sections" ("id") ON DELETE RESTRICT,
  "saved_by" text NOT NULL,
  "saved_at" timestamptz NOT NULL
);
