-- svc-agents · the session a person last selected in their session history
-- Reversal: 0005_selected_sessions.down.sql
--
-- One row per person: which of their own sessions the history shows, so the
-- choice follows them to a reload and to another device. It holds no money and
-- no usage; deleting it only forgets a selection.

CREATE TABLE IF NOT EXISTS "agents"."selected_sessions" (
  "user_id"     text PRIMARY KEY,
  "session_id"  uuid NOT NULL REFERENCES "agents"."agent_sessions" ("id") ON DELETE CASCADE,
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);
