-- trade.user_venue_agent_accounts, trade.user_venue_agent_moves · the person's agent accounts on their own venue account
-- (J-agents-21; src/venue/agent-account.ts). Reversal: 20261109120000_user_venue_agent_accounts.down.sql
--
-- An agent account is a venue sub-account under the person's wallet, opened and funded by the person's own signed
-- actions. What is kept here is the person's cap and the moves they asked for, so the cap is held to their moves in less
-- their moves out before the wallet is asked to sign another move in. Nothing here is a balance: the venue is the record
-- of what the sub-account holds, and the ledger posts nothing for it. Amounts are canonical decimal strings.

CREATE TABLE IF NOT EXISTS trade.user_venue_agent_accounts (
  user_id text NOT NULL CONSTRAINT user_venue_agent_accounts_user_ck CHECK (length(btrim(user_id)) > 0),
  account_id uuid NOT NULL,
  venue_id text NOT NULL,
  owner text NOT NULL CONSTRAINT user_venue_agent_accounts_owner_ck CHECK (owner ~ '^0x[0-9a-f]{40}$'),
  sub_account text,
  name text NOT NULL CONSTRAINT user_venue_agent_accounts_name_ck CHECK (length(btrim(name)) BETWEEN 1 AND 64),
  asset text NOT NULL,
  cap text NOT NULL CONSTRAINT user_venue_agent_accounts_cap_ck CHECK (cap ~ '^[0-9]+(\.[0-9]+)?$'),
  agent_address text NOT NULL CONSTRAINT user_venue_agent_accounts_agent_ck CHECK (agent_address ~ '^0x[0-9a-f]{40}$'),
  fund_amount text NOT NULL CONSTRAINT user_venue_agent_accounts_fund_ck CHECK (fund_amount ~ '^[0-9]+(\.[0-9]+)?$'),
  status text NOT NULL CONSTRAINT user_venue_agent_accounts_status_ck CHECK (status IN ('opening', 'open', 'closed', 'abandoned')),
  created_at timestamptz NOT NULL,
  opened_at timestamptz,
  closed_at timestamptz,
  PRIMARY KEY (user_id, account_id),
  CONSTRAINT user_venue_agent_accounts_open_ck CHECK (status NOT IN ('open', 'closed') OR (sub_account IS NOT NULL AND opened_at IS NOT NULL)),
  CONSTRAINT user_venue_agent_accounts_closed_ck CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

-- One agent key per agent account, ever: an address is never approved twice.
CREATE UNIQUE INDEX IF NOT EXISTS user_venue_agent_accounts_agent_uq ON trade.user_venue_agent_accounts (agent_address);

CREATE TABLE IF NOT EXISTS trade.user_venue_agent_moves (
  user_id text NOT NULL,
  account_id uuid NOT NULL,
  -- The move's business key is `agent:move:<move_id>`: the key its prepared, signed action is stored under.
  move_id uuid NOT NULL,
  direction text NOT NULL CONSTRAINT user_venue_agent_moves_direction_ck CHECK (direction IN ('into_sub_account', 'out_of_sub_account')),
  amount text NOT NULL CONSTRAINT user_venue_agent_moves_amount_ck CHECK (amount ~ '^[0-9]+(\.[0-9]+)?$' AND amount !~ '^0+(\.0+)?$'),
  state text NOT NULL CONSTRAINT user_venue_agent_moves_state_ck CHECK (state IN ('pending', 'done', 'refused')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, move_id),
  FOREIGN KEY (user_id, account_id) REFERENCES trade.user_venue_agent_accounts (user_id, account_id)
);
CREATE INDEX IF NOT EXISTS user_venue_agent_moves_account_idx ON trade.user_venue_agent_moves (user_id, account_id);

-- A move is never deleted, its terms never change, and a settled move stays settled.
CREATE OR REPLACE FUNCTION trade.user_venue_agent_moves_settle_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'trade.user_venue_agent_moves: a move is never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.move_id IS DISTINCT FROM OLD.move_id OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.state <> 'pending' AND NEW.state IS DISTINCT FROM OLD.state) THEN
    RAISE EXCEPTION 'trade.user_venue_agent_moves: only a pending move''s state may change, once.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS user_venue_agent_moves_settle_once_trg ON trade.user_venue_agent_moves;
CREATE TRIGGER user_venue_agent_moves_settle_once_trg
  BEFORE UPDATE OR DELETE ON trade.user_venue_agent_moves
  FOR EACH ROW EXECUTE FUNCTION trade.user_venue_agent_moves_settle_once();
