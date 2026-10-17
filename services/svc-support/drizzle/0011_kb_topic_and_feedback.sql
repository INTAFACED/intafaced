-- svc-support · article topic on the immutable version row, and feedback
-- Reversal: 0011_kb_topic_and_feedback.down.sql
--
-- NOT tagged `intafaced:destructive`: it adds two columns and one table.
-- It drops no table, no column, and no row. It seeds no article, category,
-- tag, or vote.
--
-- Category and tags live on kb_article_versions, not on kb_articles.
-- Migration 0008 refuses UPDATE and DELETE of a version row, so a topic
-- cannot be rewritten in place. kb_articles_version_locked allows an UPDATE
-- that leaves title_key, body_key, and revision unchanged, so a column on
-- the head could change without a new version. A new publish inserts a new
-- version row (the trigger allows INSERT). Existing version rows keep
-- category and tags null.

ALTER TABLE "support"."kb_article_versions" ADD COLUMN IF NOT EXISTS "category" text;
ALTER TABLE "support"."kb_article_versions" ADD COLUMN IF NOT EXISTS "tags" jsonb;

ALTER TABLE "support"."kb_article_versions" DROP CONSTRAINT IF EXISTS "kb_article_versions_category_len_ck";
ALTER TABLE "support"."kb_article_versions" ADD CONSTRAINT "kb_article_versions_category_len_ck"
  CHECK ("category" IS NULL OR (char_length("category") BETWEEN 1 AND 200));

ALTER TABLE "support"."kb_article_versions" DROP CONSTRAINT IF EXISTS "kb_article_versions_tags_array_ck";
ALTER TABLE "support"."kb_article_versions" ADD CONSTRAINT "kb_article_versions_tags_array_ck"
  CHECK ("tags" IS NULL OR jsonb_typeof("tags") = 'array');

CREATE TABLE IF NOT EXISTS "support"."kb_feedback" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "article_id"         text NOT NULL,
  "version"            integer NOT NULL,
  "user_id"            text NOT NULL,
  "helpful"            boolean NOT NULL,
  "client_request_id"  text NOT NULL,
  "created_at"         timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("user_id", "article_id", "version"),
  UNIQUE ("user_id", "client_request_id"),
  FOREIGN KEY ("article_id", "version") REFERENCES "support"."kb_article_versions" ("id", "version") ON DELETE RESTRICT
);

ALTER TABLE "support"."kb_feedback" DROP CONSTRAINT IF EXISTS "kb_feedback_request_len_ck";
ALTER TABLE "support"."kb_feedback" ADD CONSTRAINT "kb_feedback_request_len_ck"
  CHECK (char_length("client_request_id") BETWEEN 1 AND 200);
