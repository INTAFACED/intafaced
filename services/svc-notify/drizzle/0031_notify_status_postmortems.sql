-- svc-notify · incident postmortems (SP-status-02)
-- Reversal: 0031_notify_status_postmortems.down.sql
--
-- One postmortem per incident, written only once the incident is resolved. A draft moves by version (an edit names the
-- version it read); publishing spends a second founder's identity approval bound to the exact version and wording, and a
-- published postmortem is never edited. The approval it spent is kept, so the same approval cannot publish twice.
CREATE TABLE IF NOT EXISTS notify.status_postmortems (
  incident_id uuid PRIMARY KEY,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000),
  version integer NOT NULL CHECK (version >= 1),
  status text NOT NULL CHECK (status IN ('draft', 'published')),
  written_by text NOT NULL,
  written_at timestamptz NOT NULL,
  approval_id text UNIQUE,
  published_by text,
  published_at timestamptz,
  CHECK ((status = 'published') = (published_at IS NOT NULL AND approval_id IS NOT NULL AND published_by IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS notify.status_postmortem_approval_uses (
  approval_id text PRIMARY KEY,
  incident_id uuid NOT NULL,
  publisher_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('published', 'refused_same_operator', 'refused_action')),
  created_at timestamptz NOT NULL DEFAULT now()
);
