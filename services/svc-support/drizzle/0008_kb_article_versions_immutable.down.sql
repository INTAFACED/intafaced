-- Reverse 0008_kb_article_versions_immutable.sql

DROP TRIGGER IF EXISTS "kb_articles_version_locked_trg" ON "support"."kb_articles";
DROP FUNCTION IF EXISTS "support"."kb_articles_version_locked"();

DROP TRIGGER IF EXISTS "kb_article_versions_immutable_trg" ON "support"."kb_article_versions";
DROP FUNCTION IF EXISTS "support"."kb_article_versions_immutable"();
