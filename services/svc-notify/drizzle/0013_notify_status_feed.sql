-- svc-notify · status feed fields on public notices
-- Reversal: 0013_notify_status_feed.down.sql
--
-- impact, components, parent_id and resolves describe an incident update or a
-- maintenance window for the status feed. They are set at draft time and are
-- frozen with the rest of the row once published. Existing rows keep the
-- defaults: no impact, no components, not an update, does not close anything.

ALTER TABLE "notify"."notices"
  ADD COLUMN IF NOT EXISTS "impact"     text,
  ADD COLUMN IF NOT EXISTS "components" text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "parent_id"  uuid REFERENCES "notify"."notices" ("id"),
  ADD COLUMN IF NOT EXISTS "resolves"   boolean NOT NULL DEFAULT false;

ALTER TABLE "notify"."notices" DROP CONSTRAINT IF EXISTS "notices_impact_ck";
ALTER TABLE "notify"."notices" ADD CONSTRAINT "notices_impact_ck"
  CHECK ("impact" IS NULL OR "impact" IN ('none', 'minor', 'major', 'critical'));

ALTER TABLE "notify"."notices" DROP CONSTRAINT IF EXISTS "notices_components_ck";
ALTER TABLE "notify"."notices" ADD CONSTRAINT "notices_components_ck"
  CHECK ("components" <@ ARRAY['api', 'webhooks', 'console']::text[]);

-- Only incidents carry an impact, a parent or a close flag; only incidents and maintenance carry components.
ALTER TABLE "notify"."notices" DROP CONSTRAINT IF EXISTS "notices_status_fields_ck";
ALTER TABLE "notify"."notices" ADD CONSTRAINT "notices_status_fields_ck" CHECK (
  ("kind" = 'incident' OR ("impact" IS NULL AND "parent_id" IS NULL AND "resolves" = false))
  AND ("kind" IN ('incident', 'maintenance') OR cardinality("components") = 0)
);

CREATE INDEX IF NOT EXISTS "notices_parent_idx"
  ON "notify"."notices" ("parent_id")
  WHERE "parent_id" IS NOT NULL;

CREATE OR REPLACE FUNCTION notify.notice_published_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status = 'published' THEN
    RAISE EXCEPTION 'notify.notice_published_immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'published' THEN
    IF OLD.id IS DISTINCT FROM NEW.id
      OR OLD.kind IS DISTINCT FROM NEW.kind
      OR OLD.title IS DISTINCT FROM NEW.title
      OR OLD.body IS DISTINCT FROM NEW.body
      OR OLD.published_at IS DISTINCT FROM NEW.published_at
      OR OLD.author_id IS DISTINCT FROM NEW.author_id
      OR OLD.version IS DISTINCT FROM NEW.version
      OR OLD.client_request_id IS DISTINCT FROM NEW.client_request_id
      OR OLD.created_at IS DISTINCT FROM NEW.created_at
      OR OLD.status IS DISTINCT FROM NEW.status
      OR OLD.impact IS DISTINCT FROM NEW.impact
      OR OLD.components IS DISTINCT FROM NEW.components
      OR OLD.parent_id IS DISTINCT FROM NEW.parent_id
      OR OLD.resolves IS DISTINCT FROM NEW.resolves
    THEN
      RAISE EXCEPTION 'notify.notice_published_immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
