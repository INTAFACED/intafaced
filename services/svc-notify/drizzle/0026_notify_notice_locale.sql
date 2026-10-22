-- svc-notify · locale on public notices (SP-developer-status-02, lead ruling D27 (1))
-- Reversal: 0026_notify_notice_locale.down.sql
--
-- The public announcements read filters by locale. The allowed set is en only.
-- ADD COLUMN ... NOT NULL DEFAULT backfills every existing row as en (no UPDATE,
-- so the published-row trigger is not fired). Tags stay
-- an open owner value, so no tag column is added here. A published row keeps
-- its locale frozen with the rest of the row.

ALTER TABLE "notify"."notices"
  ADD COLUMN IF NOT EXISTS "locale" text NOT NULL DEFAULT 'en';

ALTER TABLE "notify"."notices" DROP CONSTRAINT IF EXISTS "notices_locale_ck";
ALTER TABLE "notify"."notices" ADD CONSTRAINT "notices_locale_ck" CHECK ("locale" IN ('en'));

CREATE INDEX IF NOT EXISTS "notices_published_kind_locale_idx"
  ON "notify"."notices" ("kind", "locale", "published_at" DESC)
  WHERE "status" = 'published';

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
      OR OLD.asset IS DISTINCT FROM NEW.asset
      OR OLD.network IS DISTINCT FROM NEW.network
      OR OLD.phase IS DISTINCT FROM NEW.phase
      OR OLD.locale IS DISTINCT FROM NEW.locale
    THEN
      RAISE EXCEPTION 'notify.notice_published_immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
