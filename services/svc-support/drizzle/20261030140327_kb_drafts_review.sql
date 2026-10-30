-- svc-support · help-article drafts, review by a second operator, and templates (SP-kb-01, SP-kb-02)
-- Reversal: 20261030140327_kb_drafts_review.down.sql
--
-- NOT tagged `intafaced:destructive`: it adds columns and tables. It drops nothing and changes no stored row. It seeds no
-- article, template or review.
--
-- A draft is an immutable version row like any other (0008 refuses UPDATE and DELETE), marked `draft`. The article head
-- (`kb_articles.revision`) stays on the live version, so every reader sees what it saw before; drafts sit above it. A
-- publish from a draft writes a new, non-draft version and moves the head there. `author_id` names who saved a draft, so
-- the review can refuse the author approving their own words. Existing rows are not drafts and have no author.

ALTER TABLE "support"."kb_article_versions" ADD COLUMN IF NOT EXISTS "draft" boolean NOT NULL DEFAULT false;
ALTER TABLE "support"."kb_article_versions" ADD COLUMN IF NOT EXISTS "author_id" text;
ALTER TABLE "support"."kb_article_versions" ADD COLUMN IF NOT EXISTS "template_id" text;
ALTER TABLE "support"."kb_article_versions" ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now();
-- The draft revision a published version was made from, so a publish retried after a crash finds its own version.
ALTER TABLE "support"."kb_article_versions" ADD COLUMN IF NOT EXISTS "source_revision" integer;

ALTER TABLE "support"."kb_article_versions" DROP CONSTRAINT IF EXISTS "kb_article_versions_draft_author_ck";
ALTER TABLE "support"."kb_article_versions" ADD CONSTRAINT "kb_article_versions_draft_author_ck"
  CHECK (NOT "draft" OR "author_id" IS NOT NULL);

-- One review per draft version. Its state only moves forward: in review, then approved, then published; or sent back.
CREATE TABLE IF NOT EXISTS "support"."kb_reviews" (
  "article_id"   text NOT NULL,
  "revision"     integer NOT NULL,
  "author_id"    text NOT NULL,
  "state"        text NOT NULL,
  "submitted_by" text NOT NULL,
  "submitted_at" timestamptz NOT NULL,
  "approved_by"  text,
  "approved_at"  timestamptz,
  "published_by" text,
  "published_at" timestamptz,
  "published_revision" integer,
  "updated_at"   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("article_id", "revision"),
  CONSTRAINT "kb_reviews_state_ck" CHECK ("state" IN ('in_review', 'approved', 'published', 'sent_back')),
  CONSTRAINT "kb_reviews_second_operator_ck" CHECK ("approved_by" IS NULL OR "approved_by" <> "author_id"),
  CONSTRAINT "kb_reviews_approved_ck" CHECK ("state" NOT IN ('approved', 'published') OR "approved_by" IS NOT NULL),
  CONSTRAINT "kb_reviews_published_ck" CHECK ("state" <> 'published' OR ("published_by" IS NOT NULL AND "published_revision" IS NOT NULL))
);

-- The review trail: one row per submit, approve, send back and publish. Append only.
CREATE TABLE IF NOT EXISTS "support"."kb_review_log" (
  "id"         bigserial PRIMARY KEY,
  "article_id" text NOT NULL,
  "revision"   integer NOT NULL,
  "action"     text NOT NULL,
  "actor_id"   text NOT NULL,
  "reason"     text,
  "at"         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "kb_review_log_action_ck" CHECK ("action" IN ('submit', 'approve', 'send_back', 'publish'))
);
CREATE INDEX IF NOT EXISTS "kb_review_log_article_idx" ON "support"."kb_review_log" ("article_id", "id");

CREATE OR REPLACE FUNCTION "support"."kb_review_log_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'support.kb_review_log is append-only: % refused', TG_OP USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "kb_review_log_append_only_trg" ON "support"."kb_review_log";
CREATE TRIGGER "kb_review_log_append_only_trg"
  BEFORE UPDATE OR DELETE ON "support"."kb_review_log"
  FOR EACH ROW EXECUTE FUNCTION "support"."kb_review_log_append_only"();

-- Article templates the desk writes. None ships: an empty list says so.
CREATE TABLE IF NOT EXISTS "support"."kb_templates" (
  "id"         text PRIMARY KEY,
  "name"       text NOT NULL,
  "body"       text NOT NULL,
  "revision"   integer NOT NULL,
  "retired"    boolean NOT NULL DEFAULT false,
  "updated_by" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "kb_templates_revision_ck" CHECK ("revision" >= 1)
);

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
