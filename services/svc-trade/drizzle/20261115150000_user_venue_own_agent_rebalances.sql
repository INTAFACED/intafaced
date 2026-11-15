-- trade.user_venue_own_agent_rebalances · the Portfolio planner's rebalance proposals for a person's own agent's venue
-- sub-account, and whether the person approved or rejected each (J-agents-18 #1 #2; src/venue/own-agent-rebalance.ts).
-- Reversal: 20261115150000_user_venue_own_agent_rebalances.down.sql
--
-- A proposal is never money: the venue is the record of what the sub-account holds, and the ledger posts nothing for it.
-- It keeps what the venue reported when it was made (holdings, mids) and the market orders it proposes, each with an
-- order id derived from the proposal's id, so approving it again is the same orders. Approving places them through the
-- agent's allowance (trade.user_venue_own_agent_draws); rejecting changes nothing. Amounts are canonical decimal strings.

CREATE TABLE IF NOT EXISTS trade.user_venue_own_agent_rebalances (
  user_id text NOT NULL CONSTRAINT user_venue_own_agent_rebalances_user_ck CHECK (length(btrim(user_id)) > 0),
  proposal_id uuid NOT NULL,
  -- svc-agents' id of the person's own agent: an opaque id here, never a join.
  agent_id uuid NOT NULL,
  allowance_id uuid NOT NULL,
  sub_account text NOT NULL CONSTRAINT user_venue_own_agent_rebalances_sub_ck CHECK (sub_account ~ '^0x[0-9a-f]{40}$'),
  asset text NOT NULL,
  targets jsonb NOT NULL,
  holdings jsonb NOT NULL,
  total_value text NOT NULL CONSTRAINT user_venue_own_agent_rebalances_total_ck CHECK (total_value ~ '^[0-9]+(\.[0-9]+)?$'),
  orders jsonb NOT NULL CONSTRAINT user_venue_own_agent_rebalances_orders_ck CHECK (jsonb_typeof(orders) = 'array' AND jsonb_array_length(orders) > 0),
  status text NOT NULL CONSTRAINT user_venue_own_agent_rebalances_status_ck CHECK (status IN ('proposed', 'approved', 'rejected')),
  created_at timestamptz NOT NULL,
  decided_at timestamptz,
  PRIMARY KEY (user_id, proposal_id),
  FOREIGN KEY (user_id, allowance_id) REFERENCES trade.user_venue_own_agent_allowances (user_id, allowance_id),
  CONSTRAINT user_venue_own_agent_rebalances_decided_ck CHECK ((status = 'proposed') = (decided_at IS NULL))
);
CREATE INDEX IF NOT EXISTS user_venue_own_agent_rebalances_agent_idx ON trade.user_venue_own_agent_rebalances (user_id, agent_id);

-- A proposal is never deleted, its orders never change, and it is decided once.
CREATE OR REPLACE FUNCTION trade.user_venue_own_agent_rebalances_decide_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'trade.user_venue_own_agent_rebalances: a proposal is never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.proposal_id IS DISTINCT FROM OLD.proposal_id
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id OR NEW.allowance_id IS DISTINCT FROM OLD.allowance_id
     OR NEW.sub_account IS DISTINCT FROM OLD.sub_account OR NEW.asset IS DISTINCT FROM OLD.asset
     OR NEW.targets IS DISTINCT FROM OLD.targets OR NEW.holdings IS DISTINCT FROM OLD.holdings
     OR NEW.total_value IS DISTINCT FROM OLD.total_value OR NEW.orders IS DISTINCT FROM OLD.orders
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR OLD.status <> 'proposed' THEN
    RAISE EXCEPTION 'trade.user_venue_own_agent_rebalances: only a proposed one may be decided, once.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS user_venue_own_agent_rebalances_decide_once_trg ON trade.user_venue_own_agent_rebalances;
CREATE TRIGGER user_venue_own_agent_rebalances_decide_once_trg
  BEFORE UPDATE OR DELETE ON trade.user_venue_own_agent_rebalances
  FOR EACH ROW EXECUTE FUNCTION trade.user_venue_own_agent_rebalances_decide_once();
