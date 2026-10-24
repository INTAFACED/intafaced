-- Reverse 0032_kb_library.sql
-- Lossy: articles typed in the desk lose their text, and the categories, sections and their log are dropped.
DROP TRIGGER IF EXISTS "kb_library_log_append_only_trg" ON "support"."kb_library_log";
DROP FUNCTION IF EXISTS "support"."kb_library_log_append_only"();
DROP TABLE IF EXISTS "support"."kb_library_log";
ALTER TABLE "support"."kb_article_versions" DROP CONSTRAINT IF EXISTS "kb_article_versions_section_fk";
ALTER TABLE "support"."kb_article_versions" DROP CONSTRAINT IF EXISTS "kb_article_versions_text_ck";
DROP TABLE IF EXISTS "support"."kb_sections";
DROP TABLE IF EXISTS "support"."kb_categories";
ALTER TABLE "support"."kb_article_versions" DROP COLUMN IF EXISTS "section_id";
ALTER TABLE "support"."kb_article_versions" DROP COLUMN IF EXISTS "language";
ALTER TABLE "support"."kb_article_versions" DROP COLUMN IF EXISTS "body";
ALTER TABLE "support"."kb_article_versions" DROP COLUMN IF EXISTS "title";
