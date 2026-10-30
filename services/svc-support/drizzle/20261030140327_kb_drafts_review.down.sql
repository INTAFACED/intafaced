-- svc-support · reverses 20261030140327_kb_drafts_review.sql
DROP TABLE IF EXISTS "support"."kb_templates";
DROP TRIGGER IF EXISTS "kb_review_log_append_only_trg" ON "support"."kb_review_log";
DROP FUNCTION IF EXISTS "support"."kb_review_log_append_only"();
DROP TABLE IF EXISTS "support"."kb_review_log";
DROP TABLE IF EXISTS "support"."kb_reviews";
ALTER TABLE "support"."kb_article_versions" DROP CONSTRAINT IF EXISTS "kb_article_versions_draft_author_ck";
ALTER TABLE "support"."kb_article_versions" DROP COLUMN IF EXISTS "created_at";
ALTER TABLE "support"."kb_article_versions" DROP COLUMN IF EXISTS "template_id";
ALTER TABLE "support"."kb_article_versions" DROP COLUMN IF EXISTS "author_id";
ALTER TABLE "support"."kb_article_versions" DROP COLUMN IF EXISTS "draft";
