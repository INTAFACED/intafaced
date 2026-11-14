-- trade.user_venue_agent_order_calls · what svc-trade answered each call of the assistant's order route (J-agents-21 #11;
-- src/venue/agent-order-calls.ts). Reversal: 20261113154312_user_venue_agent_order_calls.down.sql
--
-- The edge logs every call an API key makes (identity's api_key_calls, DV-keys-06) by its request id, with method, path
-- and status. This adds, for the one route a connected agent key trades through, what only svc-trade knows: the order
-- the call named (the assistant's clientOrderId, and the venue's order id once the venue answered) and the refusal code
-- when it was refused. Keyed by the edge's request id, so a call is recorded once. Nothing here is a balance. A row is
-- never changed or deleted: the log is append-only.

CREATE TABLE IF NOT EXISTS trade.user_venue_agent_order_calls (
  request_id text PRIMARY KEY CONSTRAINT user_venue_agent_order_calls_request_ck CHECK (length(btrim(request_id)) BETWEEN 1 AND 128),
  key_id uuid NOT NULL,
  user_id text NOT NULL CONSTRAINT user_venue_agent_order_calls_user_ck CHECK (length(btrim(user_id)) > 0),
  client_order_id text,
  venue_order_id text,
  code text,
  called_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS user_venue_agent_order_calls_key_idx ON trade.user_venue_agent_order_calls (user_id, key_id, called_at DESC);

CREATE OR REPLACE FUNCTION trade.user_venue_agent_order_calls_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'trade.user_venue_agent_order_calls: the log is append-only.' USING ERRCODE = 'restrict_violation';
END;
$$;
DROP TRIGGER IF EXISTS user_venue_agent_order_calls_append_only_trg ON trade.user_venue_agent_order_calls;
CREATE TRIGGER user_venue_agent_order_calls_append_only_trg
  BEFORE UPDATE OR DELETE ON trade.user_venue_agent_order_calls
  FOR EACH ROW EXECUTE FUNCTION trade.user_venue_agent_order_calls_append_only();
