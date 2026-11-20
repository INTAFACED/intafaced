-- trade.user_venue_agent_connections · which of the person's own agent API keys trades which of their agent accounts
-- (J-agents-21 #6 #7; src/venue/agent-connection-store.ts). Reversal: 20261111122333_user_venue_agent_connections.down.sql
--
-- The person binds one of their own `agent` API keys (identity's key id) to one of their open agent accounts; from then
-- on an order from that key is placed only on that account's venue sub-account, signed by the agent key INTAFACED holds
-- for it. Nothing here is a balance. A connection is never deleted: it ends (`ended_at`), and a key has at most one
-- connection that has not ended.

CREATE TABLE IF NOT EXISTS trade.user_venue_agent_connections (
  key_id uuid NOT NULL,
  user_id text NOT NULL CONSTRAINT user_venue_agent_connections_user_ck CHECK (length(btrim(user_id)) > 0),
  account_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  ended_at timestamptz,
  PRIMARY KEY (key_id, created_at),
  FOREIGN KEY (user_id, account_id) REFERENCES trade.user_venue_agent_accounts (user_id, account_id),
  CONSTRAINT user_venue_agent_connections_order_ck CHECK (ended_at IS NULL OR ended_at >= created_at)
);

-- One active connection per key.
CREATE UNIQUE INDEX IF NOT EXISTS user_venue_agent_connections_active_uq
  ON trade.user_venue_agent_connections (key_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS user_venue_agent_connections_account_idx ON trade.user_venue_agent_connections (user_id, account_id);

-- A connection is never deleted, its terms never change, and once ended it stays ended.
CREATE OR REPLACE FUNCTION trade.user_venue_agent_connections_end_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'trade.user_venue_agent_connections: a connection is never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.key_id IS DISTINCT FROM OLD.key_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.ended_at IS NOT NULL AND NEW.ended_at IS DISTINCT FROM OLD.ended_at) THEN
    RAISE EXCEPTION 'trade.user_venue_agent_connections: only an active connection may end, once.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS user_venue_agent_connections_end_once_trg ON trade.user_venue_agent_connections;
CREATE TRIGGER user_venue_agent_connections_end_once_trg
  BEFORE UPDATE OR DELETE ON trade.user_venue_agent_connections
  FOR EACH ROW EXECUTE FUNCTION trade.user_venue_agent_connections_end_once();
