-- Reverse 0022_kb_article_audience.sql
-- Lossy: every article reads as public again and the record of audience changes is dropped.
DROP TRIGGER IF EXISTS "kb_audience_changes_append_only_trg" ON "support"."kb_audience_changes";
DROP FUNCTION IF EXISTS "support"."kb_audience_changes_append_only"();
DROP TABLE IF EXISTS "support"."kb_audience_changes";
ALTER TABLE "support"."kb_article_versions" DROP CONSTRAINT IF EXISTS "kb_article_versions_audience_ck";
ALTER TABLE "support"."kb_article_versions" DROP COLUMN IF EXISTS "audience";
