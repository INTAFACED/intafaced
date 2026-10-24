-- svc-notify · incident templates (SP-status-02)
-- Reversal: 0029_notify_incident_templates.down.sql
--
-- Wording the founders keep for incidents they expect, picked when declaring one. Nothing is seeded. A template is keyed by
-- the id a founder chooses; defining it again replaces its wording, retiring it hides it from the picker and keeps the
-- row with who retired it and when. Incidents copy the wording into their own notice, so a later change never edits one.
CREATE TABLE IF NOT EXISTS notify.status_incident_templates (
  id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{1,39}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  group_name text CHECK (group_name IS NULL OR char_length(group_name) BETWEEN 1 AND 80),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  impact text CHECK (impact IS NULL OR impact IN ('none', 'minor', 'major', 'critical')),
  components text[] NOT NULL DEFAULT '{}',
  defined_by text NOT NULL,
  defined_at timestamptz NOT NULL,
  retired_by text,
  retired_at timestamptz,
  CHECK (cardinality(components) = 0 OR impact IS NOT NULL),
  CHECK ((retired_at IS NULL) = (retired_by IS NULL))
);
