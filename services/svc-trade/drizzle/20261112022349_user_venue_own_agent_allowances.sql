-- trade.user_venue_own_agent_allowances, trade.user_venue_own_agent_draws · the allowance a person gives their own agent
-- to trade one of their venue sub-accounts, and each order the agent drew on it (J-agents-08 #3 to #7;
-- src/venue/own-agent-trading.ts). Reversal: 20261112022349_user_venue_own_agent_allowances.down.sql
--
-- An allowance is a limit, never money: the venue is the record of what the sub-account holds, and the ledger posts
-- nothing for it. It names the one sub-account the agent key INTAFACED holds for it may trade (the person's wallet signs
-- the venue's agent permission for that key on that sub-account), how much notional the agent may commit in all, and
-- when it ends. A draw is written here under the allowance's row lock before the agent key signs the order, and it
-- counts until the venue refuses the order; so two draws at once can't both fit in the same room. Amounts are canonical
-- decimal strings.

CREATE TABLE IF NOT EXISTS trade.user_venue_own_agent_allowances (
  user_id text NOT NULL CONSTRAINT user_venue_own_agent_allowances_user_ck CHECK (length(btrim(user_id)) > 0),
  allowance_id uuid NOT NULL,
  -- svc-agents' id of the person's own agent: an opaque id here, never a join.
  agent_id uuid NOT NULL,
  venue_id text NOT NULL,
  owner text NOT NULL CONSTRAINT user_venue_own_agent_allowances_owner_ck CHECK (owner ~ '^0x[0-9a-f]{40}$'),
  sub_account text NOT NULL CONSTRAINT user_venue_own_agent_allowances_sub_ck CHECK (sub_account ~ '^0x[0-9a-f]{40}$'),
  asset text NOT NULL,
  amount text NOT NULL CONSTRAINT user_venue_own_agent_allowances_amount_ck CHECK (amount ~ '^[0-9]+(\.[0-9]+)?$' AND amount !~ '^0+(\.0+)?$'),
  period text NOT NULL CONSTRAINT user_venue_own_agent_allowances_period_ck CHECK (period IN ('day', 'week', 'month')),
  agent_address text NOT NULL CONSTRAINT user_venue_own_agent_allowances_agent_ck CHECK (agent_address ~ '^0x[0-9a-f]{40}$'),
  status text NOT NULL CONSTRAINT user_venue_own_agent_allowances_status_ck CHECK (status IN ('signing', 'active', 'revoked', 'abandoned')),
  created_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  active_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (user_id, allowance_id),
  CONSTRAINT user_venue_own_agent_allowances_ends_ck CHECK (ends_at > created_at),
  CONSTRAINT user_venue_own_agent_allowances_active_ck CHECK (status NOT IN ('active', 'revoked') OR active_at IS NOT NULL),
  CONSTRAINT user_venue_own_agent_allowances_revoked_ck CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

-- One agent key per allowance, ever: an address is never approved twice.
CREATE UNIQUE INDEX IF NOT EXISTS user_venue_own_agent_allowances_agent_uq ON trade.user_venue_own_agent_allowances (agent_address);
-- One live allowance per agent: a new one is granted only after the last was revoked or abandoned.
CREATE UNIQUE INDEX IF NOT EXISTS user_venue_own_agent_allowances_live_uq
  ON trade.user_venue_own_agent_allowances (user_id, agent_id) WHERE status IN ('signing', 'active');

CREATE TABLE IF NOT EXISTS trade.user_venue_own_agent_draws (
  user_id text NOT NULL,
  allowance_id uuid NOT NULL,
  -- The order's id the page chose once at its preview; its business key is `agent:order:own-<agent>:<order_id>`.
  order_id uuid NOT NULL,
  symbol text NOT NULL,
  side text NOT NULL CONSTRAINT user_venue_own_agent_draws_side_ck CHECK (side IN ('buy', 'sell')),
  order_type text NOT NULL CONSTRAINT user_venue_own_agent_draws_type_ck CHECK (order_type IN ('market', 'limit')),
  size text NOT NULL CONSTRAINT user_venue_own_agent_draws_size_ck CHECK (size ~ '^[0-9]+(\.[0-9]+)?$'),
  price text NOT NULL CONSTRAINT user_venue_own_agent_draws_price_ck CHECK (price ~ '^[0-9]+(\.[0-9]+)?$'),
  -- What the order commits against the allowance: its size at its limit (or worst) price.
  amount text NOT NULL CONSTRAINT user_venue_own_agent_draws_amount_ck CHECK (amount ~ '^[0-9]+(\.[0-9]+)?$'),
  state text NOT NULL CONSTRAINT user_venue_own_agent_draws_state_ck CHECK (state IN ('admitted', 'refused')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, order_id),
  FOREIGN KEY (user_id, allowance_id) REFERENCES trade.user_venue_own_agent_allowances (user_id, allowance_id)
);
CREATE INDEX IF NOT EXISTS user_venue_own_agent_draws_allowance_idx ON trade.user_venue_own_agent_draws (user_id, allowance_id);

-- A draw is never deleted, its terms never change, and once refused it stays refused.
CREATE OR REPLACE FUNCTION trade.user_venue_own_agent_draws_settle_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'trade.user_venue_own_agent_draws: a draw is never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.allowance_id IS DISTINCT FROM OLD.allowance_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.symbol IS DISTINCT FROM OLD.symbol OR NEW.side IS DISTINCT FROM OLD.side
     OR NEW.order_type IS DISTINCT FROM OLD.order_type OR NEW.size IS DISTINCT FROM OLD.size OR NEW.price IS DISTINCT FROM OLD.price
     OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.state = 'refused' AND NEW.state IS DISTINCT FROM OLD.state) THEN
    RAISE EXCEPTION 'trade.user_venue_own_agent_draws: only an admitted draw may be refused, once.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS user_venue_own_agent_draws_settle_once_trg ON trade.user_venue_own_agent_draws;
CREATE TRIGGER user_venue_own_agent_draws_settle_once_trg
  BEFORE UPDATE OR DELETE ON trade.user_venue_own_agent_draws
  FOR EACH ROW EXECUTE FUNCTION trade.user_venue_own_agent_draws_settle_once();
