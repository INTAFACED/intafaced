-- svc-notify · notice categories (SP-status-03)
-- Reversal: 0033_notify_notice_categories.down.sql
--
-- The founders' category list is an owner value on the status page row: blank (NULL) means the kinds alone. A notice may
-- name one category from that list; it is stored as written ({id, name}) and is part of what its publish approval
-- binds, so a published row's category never changes.
ALTER TABLE notify.status_page ADD COLUMN IF NOT EXISTS notice_categories jsonb
  CHECK (notice_categories IS NULL OR jsonb_typeof(notice_categories) = 'array');
ALTER TABLE notify.notices ADD COLUMN IF NOT EXISTS category jsonb
  CHECK (category IS NULL OR jsonb_typeof(category) = 'object');

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
    THEN
      RAISE EXCEPTION 'notify.notice_published_immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

