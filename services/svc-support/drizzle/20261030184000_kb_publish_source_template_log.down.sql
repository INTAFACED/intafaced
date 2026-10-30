-- svc-support · reverses 20261030184000_kb_publish_source_template_log.sql
DROP TABLE IF EXISTS "support"."kb_template_log";
ALTER TABLE "support"."kb_article_versions" DROP COLUMN IF EXISTS "source_revision";
