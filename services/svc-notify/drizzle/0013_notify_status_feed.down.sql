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
    THEN
      RAISE EXCEPTION 'notify.notice_published_immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP INDEX IF EXISTS "notify"."notices_parent_idx";
ALTER TABLE "notify"."notices" DROP CONSTRAINT IF EXISTS "notices_status_fields_ck";
ALTER TABLE "notify"."notices" DROP CONSTRAINT IF EXISTS "notices_components_ck";
ALTER TABLE "notify"."notices" DROP CONSTRAINT IF EXISTS "notices_impact_ck";
ALTER TABLE "notify"."notices"
  DROP COLUMN IF EXISTS "resolves",
  DROP COLUMN IF EXISTS "parent_id",
  DROP COLUMN IF EXISTS "components",
  DROP COLUMN IF EXISTS "impact";
