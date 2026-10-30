-- svc-support · publish source and template change log (SP-kb-01, SP-kb-02)
-- Reversal: 20261030184000_kb_publish_source_template_log.down.sql
--
-- NOT tagged `intafaced:destructive`: it adds a column and a table. It drops nothing and changes no stored row.

-- The draft revision a published version was made from, so a publish retried after a crash finds its own version.
ALTER TABLE "support"."kb_article_versions" ADD COLUMN IF NOT EXISTS "source_revision" integer;

-- Every template change, with who made it and why: the audit the desk's reason field feeds. Append-only.
CREATE TABLE IF NOT EXISTS "support"."kb_template_log" (
  "id"          bigserial PRIMARY KEY,
  "template_id" text NOT NULL,
  "revision"    integer NOT NULL,
  "name"        text NOT NULL,
  "body"        text NOT NULL,
  "retired"     boolean NOT NULL,
  "actor_id"    text NOT NULL,
  "reason"      text NOT NULL,
  "at"          timestamptz NOT NULL,
  CONSTRAINT "kb_template_log_revision_uq" UNIQUE ("template_id", "revision")
);
DROP TRIGGER IF EXISTS "kb_template_log_append_only_trg" ON "support"."kb_template_log";
CREATE TRIGGER "kb_template_log_append_only_trg"
  BEFORE UPDATE OR DELETE ON "support"."kb_template_log"
  FOR EACH ROW EXECUTE FUNCTION "support"."kb_review_log_append_only"();
