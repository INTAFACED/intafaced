-- intafaced:destructive — reversal of 0030_kb_authoring.sql
-- DATA LOSS: this reversal drops five tables and every row in them (drafts, published versions, sections, categories).
-- Lossy: desk-written drafts, published versions, sections and categories are dropped. The keyed spine is untouched.
DROP TABLE IF EXISTS "support"."kb_drafts";
DROP TRIGGER IF EXISTS "kb_authored_versions_immutable_trg" ON "support"."kb_authored_versions";
DROP FUNCTION IF EXISTS "support"."kb_authored_versions_immutable"();
DROP TABLE IF EXISTS "support"."kb_authored_versions";
DROP TABLE IF EXISTS "support"."kb_authored_articles";
DROP TABLE IF EXISTS "support"."kb_sections";
DROP TABLE IF EXISTS "support"."kb_categories";
