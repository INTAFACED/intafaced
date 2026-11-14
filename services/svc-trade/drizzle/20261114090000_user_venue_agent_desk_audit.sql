-- trade.user_venue_agent_desk_audit · the founder's switches on the person's outside assistant connections (J-agents-21
-- #15; src/venue/agent-desk.ts). Reversal: 20261114090000_user_venue_agent_desk_audit.down.sql
--
-- One row per switch an operator throws on an outside connection (an agent API key bound to an agent account), naming
-- the operator and their reason. A connection is quarantined once: a second quarantine of the same key reads back the
-- first row. Nothing here is a balance. A row is never changed or deleted: the audit log is append-only.

CREATE TABLE IF NOT EXISTS trade.user_venue_agent_desk_audit (
  id uuid PRIMARY KEY,
  action text NOT NULL CONSTRAINT user_venue_agent_desk_audit_action_ck CHECK (action IN ('quarantine')),
  key_id uuid NOT NULL,
  user_id text NOT NULL CONSTRAINT user_venue_agent_desk_audit_user_ck CHECK (length(btrim(user_id)) > 0),
  account_id uuid NOT NULL,
  operator_id text NOT NULL CONSTRAINT user_venue_agent_desk_audit_operator_ck CHECK (length(btrim(operator_id)) > 0),
  reason text NOT NULL CONSTRAINT user_venue_agent_desk_audit_reason_ck CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  request_id text NOT NULL CONSTRAINT user_venue_agent_desk_audit_request_ck CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  at timestamptz NOT NULL
);
-- A key is quarantined once.
CREATE UNIQUE INDEX IF NOT EXISTS user_venue_agent_desk_audit_quarantine_uq
  ON trade.user_venue_agent_desk_audit (key_id) WHERE action = 'quarantine';
CREATE INDEX IF NOT EXISTS user_venue_agent_desk_audit_at_idx ON trade.user_venue_agent_desk_audit (at DESC, id);

CREATE OR REPLACE FUNCTION trade.user_venue_agent_desk_audit_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'trade.user_venue_agent_desk_audit: the audit log is append-only.' USING ERRCODE = 'restrict_violation';
END;
$$;
DROP TRIGGER IF EXISTS user_venue_agent_desk_audit_append_only_trg ON trade.user_venue_agent_desk_audit;
CREATE TRIGGER user_venue_agent_desk_audit_append_only_trg
  BEFORE UPDATE OR DELETE ON trade.user_venue_agent_desk_audit
  FOR EACH ROW EXECUTE FUNCTION trade.user_venue_agent_desk_audit_append_only();
