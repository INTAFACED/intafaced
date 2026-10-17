-- Reverse 0011_kb_topic_and_feedback.sql

DROP TABLE IF EXISTS "support"."kb_feedback";

ALTER TABLE "support"."kb_article_versions" DROP CONSTRAINT IF EXISTS "kb_article_versions_tags_array_ck";
ALTER TABLE "support"."kb_article_versions" DROP CONSTRAINT IF EXISTS "kb_article_versions_category_len_ck";
ALTER TABLE "support"."kb_article_versions" DROP COLUMN IF EXISTS "tags";
ALTER TABLE "support"."kb_article_versions" DROP COLUMN IF EXISTS "category";
