-- trade.user_venue_auto_top_up_* · auto top-up of an isolated position's margin on the person's own venue account
-- (J-derivatives-06 #4; src/venue/auto-top-up.ts). Reversal: 20261123124904_user_venue_auto_top_up.down.sql
--
-- The venue holds the position and its margin; nothing here is a balance and the ledger posts nothing. The person's
-- wallet approves, on the venue, an agent key INTAFACED derives for their auto top-up (the agent permission), with its
-- own cap in the venue's collateral asset. For each position the person sets the margin level that starts a top-up, the
-- amount each top-up adds and a cap. Each time the position's margin (its margin and its unrealised result, as the venue
-- reports them) falls to the level, our engine adds the set amount once, one `update_isolated_margin` the agent key signs,
-- under the business key `margin:<owner>:<symbol>:auto:<sequence>`; never past the position's cap or the permission's.
-- A top-up row is written before its action is prepared, so a crash replays the same key and the venue applies it once.

CREATE TABLE IF NOT EXISTS trade.user_venue_auto_top_up_permissions (
  user_id text NOT NULL CONSTRAINT user_venue_auto_top_up_permissions_user_ck CHECK (length(btrim(user_id)) > 0),
  venue_id text NOT NULL,
  owner text NOT NULL CONSTRAINT user_venue_auto_top_up_permissions_owner_ck CHECK (owner ~ '^0x[0-9a-f]{40}$'),
  agent_address text NOT NULL CONSTRAINT user_venue_auto_top_up_permissions_agent_ck CHECK (agent_address ~ '^0x[0-9a-f]{40}$'),
  asset text NOT NULL,
  -- The most every top-up under this permission may add together, on every position. Set once, with the approval.
  cap numeric(78, 18) NOT NULL CONSTRAINT user_venue_auto_top_up_permissions_cap_ck CHECK (cap > 0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, venue_id, owner)
);

CREATE TABLE IF NOT EXISTS trade.user_venue_auto_top_ups (
  id uuid PRIMARY KEY,
  user_id text NOT NULL CONSTRAINT user_venue_auto_top_ups_user_ck CHECK (length(btrim(user_id)) > 0),
  venue_id text NOT NULL,
  owner text NOT NULL CONSTRAINT user_venue_auto_top_ups_owner_ck CHECK (owner ~ '^0x[0-9a-f]{40}$'),
  symbol text NOT NULL,
  -- The position's margin at or below which a top-up starts.
  trigger_level numeric(78, 18) NOT NULL CONSTRAINT user_venue_auto_top_ups_level_ck CHECK (trigger_level > 0),
  amount_each numeric(78, 18) NOT NULL CONSTRAINT user_venue_auto_top_ups_amount_ck CHECK (amount_each > 0),
  -- The most this position's top-ups may add together while it is on (since it was last turned on).
  cap numeric(78, 18) NOT NULL CONSTRAINT user_venue_auto_top_ups_cap_ck CHECK (cap >= amount_each),
  enabled boolean NOT NULL,
  -- Each turn-on is a new run: the cap counts the top-ups of the current run only.
  run integer NOT NULL CONSTRAINT user_venue_auto_top_ups_run_ck CHECK (run >= 1),
  -- True once the margin was read above the level since the last crossing: the next fall to it is a new crossing.
  armed boolean NOT NULL,
  -- Why the last crossing sent nothing: the position's cap, or the permission's own cap. Cleared by a new setting.
  stopped text CONSTRAINT user_venue_auto_top_ups_stopped_ck CHECK (stopped IS NULL OR stopped IN ('cap', 'permission_cap')),
  -- The next top-up's sequence: never reused, across runs, so a business key is never sent twice.
  next_sequence integer NOT NULL CONSTRAINT user_venue_auto_top_ups_seq_ck CHECK (next_sequence >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS user_venue_auto_top_ups_position_uq
  ON trade.user_venue_auto_top_ups (user_id, venue_id, owner, symbol);
CREATE INDEX IF NOT EXISTS user_venue_auto_top_ups_enabled_idx ON trade.user_venue_auto_top_ups (enabled) WHERE enabled;

CREATE TABLE IF NOT EXISTS trade.user_venue_auto_top_up_adds (
  setting_id uuid NOT NULL REFERENCES trade.user_venue_auto_top_ups (id),
  sequence integer NOT NULL CONSTRAINT user_venue_auto_top_up_adds_seq_ck CHECK (sequence >= 1),
  run integer NOT NULL,
  user_id text NOT NULL,
  venue_id text NOT NULL,
  owner text NOT NULL,
  symbol text NOT NULL,
  agent_address text NOT NULL,
  amount numeric(78, 18) NOT NULL CONSTRAINT user_venue_auto_top_up_adds_amount_ck CHECK (amount > 0),
  change_key text NOT NULL,
  -- The position's margin (margin and unrealised result) the engine read when it crossed the level.
  margin_at numeric(78, 18) NOT NULL,
  state text NOT NULL CONSTRAINT user_venue_auto_top_up_adds_state_ck CHECK (state IN ('sending', 'added', 'refused')),
  refusal text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (setting_id, sequence)
);
CREATE UNIQUE INDEX IF NOT EXISTS user_venue_auto_top_up_adds_key_uq ON trade.user_venue_auto_top_up_adds (user_id, change_key);
CREATE INDEX IF NOT EXISTS user_venue_auto_top_up_adds_permission_idx
  ON trade.user_venue_auto_top_up_adds (user_id, venue_id, owner, agent_address);

-- A top-up is never deleted, its terms never change, and only a sending one is settled, once.
CREATE OR REPLACE FUNCTION trade.user_venue_auto_top_up_adds_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'trade.user_venue_auto_top_up_adds: a top-up is never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.setting_id IS DISTINCT FROM OLD.setting_id OR NEW.sequence IS DISTINCT FROM OLD.sequence
     OR NEW.run IS DISTINCT FROM OLD.run OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.change_key IS DISTINCT FROM OLD.change_key
     OR NEW.agent_address IS DISTINCT FROM OLD.agent_address OR NEW.margin_at IS DISTINCT FROM OLD.margin_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR OLD.state <> 'sending' THEN
    RAISE EXCEPTION 'trade.user_venue_auto_top_up_adds: only a sending top-up changes, and only its state.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS user_venue_auto_top_up_adds_once_trg ON trade.user_venue_auto_top_up_adds;
CREATE TRIGGER user_venue_auto_top_up_adds_once_trg
  BEFORE UPDATE OR DELETE ON trade.user_venue_auto_top_up_adds
  FOR EACH ROW EXECUTE FUNCTION trade.user_venue_auto_top_up_adds_once();
