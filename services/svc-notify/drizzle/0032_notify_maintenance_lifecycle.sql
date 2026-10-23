-- svc-notify · scheduled maintenance lifecycle and reminders (SP-status-03)
-- Reversal: 0032_notify_maintenance_lifecycle.down.sql
--
-- A maintenance notice may carry reminder offsets (minutes before its start), part of what its publish approval binds.
-- An operator's moves on a published window (verifying, completed, cancelled) are stored once each, with who and why;
-- the state is derived from them and the start, never held by a timer. Reminders are rows keyed (window, offset).
ALTER TABLE notify.notices ADD COLUMN IF NOT EXISTS reminder_offsets integer[] NOT NULL DEFAULT '{}';

-- The offsets are part of what a publish approval binds, so a published row's offsets never change.
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
    THEN
      RAISE EXCEPTION 'notify.notice_published_immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE IF NOT EXISTS notify.maintenance_moves (
  notice_id uuid NOT NULL REFERENCES notify.notices (id),
  state text NOT NULL CHECK (state IN ('verifying', 'completed', 'cancelled')),
  moved_by text NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  moved_at timestamptz NOT NULL,
  PRIMARY KEY (notice_id, state)
);

CREATE TABLE IF NOT EXISTS notify.maintenance_reminders (
  notice_id uuid NOT NULL REFERENCES notify.notices (id),
  offset_minutes integer NOT NULL CHECK (offset_minutes BETWEEN 1 AND 43200),
  due_at timestamptz NOT NULL,
  claimed_until timestamptz,
  sent_at timestamptz,
  skipped text CHECK (skipped IN ('published_late', 'in_progress', 'verifying', 'completed', 'cancelled')),
  PRIMARY KEY (notice_id, offset_minutes),
  CHECK (sent_at IS NULL OR skipped IS NULL)
);
CREATE INDEX IF NOT EXISTS maintenance_reminders_due ON notify.maintenance_reminders (due_at)
  WHERE sent_at IS NULL AND skipped IS NULL;
