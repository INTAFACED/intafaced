-- svc-notify · developer changelog fields on public notices
-- Reversal: 0015_notify_changelog_fields.down.sql
--
-- `changelog` holds the area, breaking flag, endpoints, scopes, dates, example,
-- migration note and retired endpoints of a changelog entry. It is set at draft
-- time and frozen with the rest of the row once published. Existing rows keep
-- null, so a changelog entry written before this reads with no area.

ALTER TABLE "notify"."notices"
  ADD COLUMN IF NOT EXISTS "changelog" jsonb;

ALTER TABLE "notify"."notices" DROP CONSTRAINT IF EXISTS "notices_changelog_kind_ck";
ALTER TABLE "notify"."notices" ADD CONSTRAINT "notices_changelog_kind_ck"
  CHECK ("changelog" IS NULL OR "kind" = 'changelog');

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
      OR OLD.changelog IS DISTINCT FROM NEW.changelog
    THEN
      RAISE EXCEPTION 'notify.notice_published_immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
