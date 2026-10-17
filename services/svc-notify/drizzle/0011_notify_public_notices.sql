-- svc-notify · owner-written public notices
-- Reversal: 0011_notify_public_notices.down.sql
--
-- Drafts are invisible to signed-out reads. A published row's copy, id, and
-- published_at do not change; a correction is a new row.

CREATE TABLE IF NOT EXISTS "notify"."notices" (
  "id"                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind"                       text NOT NULL,
  "title"                      text NOT NULL,
  "body"                       text NOT NULL,
  "status"                     text NOT NULL,
  "published_at"               timestamptz,
  "starts_at"                  timestamptz,
  "ends_at"                    timestamptz,
  "version"                    integer NOT NULL DEFAULT 1,
  "author_id"                  text NOT NULL,
  "client_request_id"          text NOT NULL,
  "publish_client_request_id"  text,
  "approval_id"                text,
  "created_at"                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "notices_kind_ck" CHECK ("kind" IN ('announcement', 'maintenance', 'incident', 'changelog')),
  CONSTRAINT "notices_status_ck" CHECK ("status" IN ('draft', 'published')),
  CONSTRAINT "notices_published_time_ck" CHECK (
    ("status" = 'draft' AND "published_at" IS NULL)
    OR ("status" = 'published' AND "published_at" IS NOT NULL)
  ),
  CONSTRAINT "notices_draft_request_uq" UNIQUE ("author_id", "client_request_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "notices_approval_uq"
  ON "notify"."notices" ("approval_id")
  WHERE "approval_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "notices_publish_request_uq"
  ON "notify"."notices" ("author_id", "publish_client_request_id")
  WHERE "publish_client_request_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "notices_published_idx"
  ON "notify"."notices" ("kind", "published_at" DESC)
  WHERE "status" = 'published';

CREATE TABLE IF NOT EXISTS "notify"."notice_approval_uses" (
  "approval_id"   text PRIMARY KEY,
  "notice_id"     uuid,
  "publisher_id"  text NOT NULL,
  "outcome"       text NOT NULL,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "notice_approval_uses_outcome_ck" CHECK ("outcome" IN ('published', 'refused_same_operator'))
);

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

DROP TRIGGER IF EXISTS notice_published_immutable ON notify.notices;
CREATE TRIGGER notice_published_immutable
  BEFORE UPDATE OR DELETE ON notify.notices
  FOR EACH ROW EXECUTE FUNCTION notify.notice_published_immutable();
