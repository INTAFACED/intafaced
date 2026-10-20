-- svc-support · who may read a help article (SP-help-centre-02)
-- Reversal: 0022_kb_article_audience.down.sql
--
-- NOT tagged `intafaced:destructive`: it adds one column and one table. Every existing
-- version reads as public, which is what every published article was until now.
--
-- The audience lives on the immutable version row, like the topic (0011): changing it writes a
-- new version, so the revision check and the history both see the change. `kb_audience_changes`
-- keeps who changed it, from what and to what, and refuses UPDATE and DELETE.

ALTER TABLE "support"."kb_article_versions" ADD COLUMN IF NOT EXISTS "audience" text NOT NULL DEFAULT 'public';

ALTER TABLE "support"."kb_article_versions" DROP CONSTRAINT IF EXISTS "kb_article_versions_audience_ck";
ALTER TABLE "support"."kb_article_versions" ADD CONSTRAINT "kb_article_versions_audience_ck"
  CHECK ("audience" IN ('public', 'signed_in', 'staff'));

CREATE TABLE IF NOT EXISTS "support"."kb_audience_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "article_id" text NOT NULL,
  "from_audience" text NOT NULL,
  "to_audience" text NOT NULL,
  "from_revision" integer NOT NULL,
  "to_revision" integer NOT NULL,
  "actor_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "kb_audience_changes_from_ck" CHECK ("from_audience" IN ('public', 'signed_in', 'staff')),
  CONSTRAINT "kb_audience_changes_to_ck" CHECK ("to_audience" IN ('public', 'signed_in', 'staff')),
  CONSTRAINT "kb_audience_changes_differ_ck" CHECK ("from_audience" <> "to_audience"),
  CONSTRAINT "kb_audience_changes_revision_ck" CHECK ("to_revision" > "from_revision")
);
CREATE UNIQUE INDEX IF NOT EXISTS "kb_audience_changes_article_revision_idx" ON "support"."kb_audience_changes" ("article_id", "to_revision");

CREATE OR REPLACE FUNCTION "support"."kb_audience_changes_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'support.kb_audience_changes is append-only: % refused', TG_OP USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "kb_audience_changes_append_only_trg" ON "support"."kb_audience_changes";
CREATE TRIGGER "kb_audience_changes_append_only_trg"
  BEFORE UPDATE OR DELETE ON "support"."kb_audience_changes"
  FOR EACH ROW EXECUTE FUNCTION "support"."kb_audience_changes_append_only"();
