-- Custody transaction policy (W-custody-ops-07, wallet-custody-ops-038..042). Ordered rules, versioned. A draft is
-- published only by an approved custody `config` task with scope `policy` (W-custody-ops-06 quorum: the initiator never
-- approves their own task); `approval_task_id` names that task. A published version is immutable: an edit after
-- publishing is a new draft and a new version. No row here holds a balance or moves value. With no published version
-- every withdrawal the policy guard sees refuses (`pay.guard_custody_policy_unset`); nothing is defaulted or seeded.
CREATE TABLE IF NOT EXISTS "pay"."custody_policy_versions" (
  "version" integer PRIMARY KEY,
  "rules" jsonb NOT NULL,
  "status" text NOT NULL,
  "edited_by" text NOT NULL,
  "edited_at" timestamptz NOT NULL DEFAULT now(),
  "published_by" text,
  "published_at" timestamptz,
  "approval_task_id" uuid,
  "note" text NOT NULL,
  CONSTRAINT "custody_policy_versions_version_ck" CHECK ("version" > 0),
  CONSTRAINT "custody_policy_versions_status_ck" CHECK ("status" IN ('draft', 'published', 'superseded')),
  CONSTRAINT "custody_policy_versions_rules_ck" CHECK (jsonb_typeof("rules") = 'array'),
  CONSTRAINT "custody_policy_versions_text_ck" CHECK (length(btrim("edited_by")) > 0 AND length(btrim("note")) > 0),
  CONSTRAINT "custody_policy_versions_published_ck" CHECK (
    ("status" = 'draft' AND "published_by" IS NULL AND "published_at" IS NULL AND "approval_task_id" IS NULL)
    OR ("status" <> 'draft' AND "published_by" IS NOT NULL AND "published_at" IS NOT NULL AND "approval_task_id" IS NOT NULL)
  )
);
-- At most one open draft and at most one version in force.
CREATE UNIQUE INDEX IF NOT EXISTS "custody_policy_one_draft_uq" ON "pay"."custody_policy_versions" ("status") WHERE "status" = 'draft';
CREATE UNIQUE INDEX IF NOT EXISTS "custody_policy_one_published_uq" ON "pay"."custody_policy_versions" ("status") WHERE "status" = 'published';

-- Published rules never change: only the status may move published -> superseded.
CREATE OR REPLACE FUNCTION "pay"."custody_policy_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'draft' THEN RAISE EXCEPTION 'custody policy version % is published and immutable', OLD."version"; END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" <> 'draft' THEN
    IF NEW."rules" IS DISTINCT FROM OLD."rules" OR NEW."edited_by" IS DISTINCT FROM OLD."edited_by"
       OR NEW."published_by" IS DISTINCT FROM OLD."published_by" OR NEW."published_at" IS DISTINCT FROM OLD."published_at"
       OR NEW."approval_task_id" IS DISTINCT FROM OLD."approval_task_id"
       OR NEW."note" IS DISTINCT FROM OLD."note" OR NOT (OLD."status" = 'published' AND NEW."status" = 'superseded') THEN
      RAISE EXCEPTION 'custody policy version % is published and immutable', OLD."version";
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "custody_policy_immutable_trg" ON "pay"."custody_policy_versions";
CREATE TRIGGER "custody_policy_immutable_trg" BEFORE UPDATE OR DELETE ON "pay"."custody_policy_versions"
  FOR EACH ROW EXECUTE FUNCTION "pay"."custody_policy_immutable"();
