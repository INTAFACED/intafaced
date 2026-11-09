-- svc-notify · a notice's title and body in other languages (J-cex-spot-15 #2)
-- Reversal: 20261109013809_notify_notice_translations.down.sql
--
-- `translations` holds the operator's own text per language code, {"es": {"title": "…", "body": "…"}}. The notice's
-- `title` and `body` stay its source text. A signed-out read in a language the notice has shows that language's text and
-- says which language it is; a language it lacks shows the source text, labelled as such. Nothing is machine-translated.
-- The publish approval binds the translations, so a published notice's never change.

ALTER TABLE notify.notices ADD COLUMN IF NOT EXISTS translations jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE notify.notices DROP CONSTRAINT IF EXISTS notices_translations_object_ck;
ALTER TABLE notify.notices ADD CONSTRAINT notices_translations_object_ck CHECK (jsonb_typeof(translations) = 'object');

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
      OR OLD.reminder_offsets IS DISTINCT FROM NEW.reminder_offsets
      OR OLD.category IS DISTINCT FROM NEW.category
      OR OLD.audience IS DISTINCT FROM NEW.audience
      OR OLD.translations IS DISTINCT FROM NEW.translations
      OR (OLD.kind = 'fee_change' AND OLD.starts_at IS DISTINCT FROM NEW.starts_at)
    THEN
      RAISE EXCEPTION 'notify.notice_published_immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
