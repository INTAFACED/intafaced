-- svc-support · KB generations stay the body that was published (L1242)
-- Reversal: 0008_kb_article_versions_immutable.down.sql
--
-- NOT tagged `intafaced:destructive`: it adds two functions and two triggers.
-- It drops no table, no column, and no row. 0004's backfill is left as it
-- was: insert-only, and this file does not write a version body.
--
-- 0004 called kb_article_versions immutable and never installed a trigger.
-- An update of title_key or body_key on (id, version) replaced the body
-- getKb({ id, version }) returns. Row removal dropped that generation.
-- kb_articles also accepted a new title_key or body_key without bumping
-- revision or inserting the matching version row, so the head and the
-- version row for the same number could disagree.
--
-- The head check is deferred to commit. putKbRevision updates kb_articles
-- and only then inserts the version row, in one transaction. An immediate
-- check would refuse that order. A published flag or updated_at change
-- that leaves title_key, body_key, and revision alone is not a new generation.

CREATE OR REPLACE FUNCTION "support"."kb_article_versions_immutable"() RETURNS trigger AS $$
DECLARE
  head_title text;
  head_body text;
  head_revision integer;
BEGIN
  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'support.kb_article_versions is immutable: % refused on id % version %', TG_OP, OLD."id", OLD."version"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT a."title_key", a."body_key", a."revision"
    INTO head_title, head_body, head_revision
    FROM "support"."kb_articles" AS a
   WHERE a."id" = NEW."id";

  IF FOUND
     AND head_revision = NEW."version"
     AND (head_title IS DISTINCT FROM NEW."title_key" OR head_body IS DISTINCT FROM NEW."body_key") THEN
    RAISE EXCEPTION 'support.kb_article_versions disagrees with kb_articles head for id % version %', NEW."id", NEW."version"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "kb_article_versions_immutable_trg" ON "support"."kb_article_versions";
CREATE TRIGGER "kb_article_versions_immutable_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "support"."kb_article_versions"
  FOR EACH ROW EXECUTE FUNCTION "support"."kb_article_versions_immutable"();

CREATE OR REPLACE FUNCTION "support"."kb_articles_version_locked"() RETURNS trigger AS $$
DECLARE
  version_title text;
  version_body text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."title_key" IS NOT DISTINCT FROM OLD."title_key"
     AND NEW."body_key" IS NOT DISTINCT FROM OLD."body_key"
     AND NEW."revision" IS NOT DISTINCT FROM OLD."revision" THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."revision" <= OLD."revision" THEN
    RAISE EXCEPTION 'support.kb_articles title_key or body_key change refused without a revision bump on id %', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT v."title_key", v."body_key"
    INTO version_title, version_body
    FROM "support"."kb_article_versions" AS v
   WHERE v."id" = NEW."id"
     AND v."version" = NEW."revision";

  IF NOT FOUND
     OR version_title IS DISTINCT FROM NEW."title_key"
     OR version_body IS DISTINCT FROM NEW."body_key" THEN
    RAISE EXCEPTION 'support.kb_articles head disagrees with kb_article_versions for id % revision %', NEW."id", NEW."revision"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "kb_articles_version_locked_trg" ON "support"."kb_articles";
CREATE CONSTRAINT TRIGGER "kb_articles_version_locked_trg"
  AFTER INSERT OR UPDATE ON "support"."kb_articles"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "support"."kb_articles_version_locked"();
