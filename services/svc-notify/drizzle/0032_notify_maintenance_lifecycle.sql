-- svc-notify · scheduled maintenance lifecycle and reminders (SP-status-03)
-- Reversal: 0032_notify_maintenance_lifecycle.down.sql
--
-- A maintenance notice may carry reminder offsets (minutes before its start), part of what its publish approval binds.
-- An operator's moves on a published window (verifying, completed, cancelled) are stored once each, with who and why;
-- the state is derived from them and the start, never held by a timer. Reminders are rows keyed (window, offset).
ALTER TABLE notify.notices ADD COLUMN IF NOT EXISTS reminder_offsets integer[] NOT NULL DEFAULT '{}';

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
  skipped text CHECK (skipped IN ('in_progress', 'verifying', 'completed', 'cancelled')),
  PRIMARY KEY (notice_id, offset_minutes),
  CHECK (sent_at IS NULL OR skipped IS NULL)
);
CREATE INDEX IF NOT EXISTS maintenance_reminders_due ON notify.maintenance_reminders (due_at)
  WHERE sent_at IS NULL AND skipped IS NULL;
