-- svc-agents · what each session of a person's own agent opened on (AG-builder-03; J-agents-03 #7)
-- Reversal: 20261104185906_own_agent_session_versions.down.sql
--
-- What a session of an own agent opened on: its version and that version's instructions as they stood at the open, so
-- each run of the session reads them whatever is edited or published after. One row per session, never changed.
CREATE TABLE IF NOT EXISTS "agents"."own_agent_session_versions" (
  "session_id"    uuid PRIMARY KEY,
  "agent_id"      uuid NOT NULL REFERENCES "agents"."own_agents" ("id"),
  "owner_id"      text NOT NULL,
  "version"       integer NOT NULL,
  "instructions"  text NOT NULL,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "own_agent_session_versions_version_ck" CHECK ("version" >= 1)
);
