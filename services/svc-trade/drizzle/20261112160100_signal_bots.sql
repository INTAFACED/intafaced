-- trade.signal_bots · signal bots run from a bought signal listing (CB-bots-api-signal-04, J-copy-bots-otc-21 #1 #2 #3)
-- Reversal: 20261112160100_signal_bots.down.sql
--
-- A person creates a signal bot from a signal listing they bought access to in svc-market (read through svc-market's
-- internal access door, fail closed; never its tables). The same client bot id again returns the same bot. The bot's
-- cap is the owner's signal bot cap at create (blank refuses the create), a limit and never money: INTAFACED holds
-- nothing here. A new bot waits for its first signal (`awaiting_signal`).

CREATE TABLE IF NOT EXISTS trade.signal_bots (
  id uuid PRIMARY KEY,
  user_id text NOT NULL CONSTRAINT signal_bots_user_ck CHECK (length(btrim(user_id)) > 0),
  client_bot_id text NOT NULL CONSTRAINT signal_bots_client_ck CHECK (length(client_bot_id) BETWEEN 1 AND 120),
  listing_id uuid NOT NULL,
  -- The listing's title as svc-market answered it at create, so My bots names the bot without a cross-service read.
  title text NOT NULL,
  state text NOT NULL CONSTRAINT signal_bots_state_ck CHECK (state IN ('awaiting_signal', 'active', 'stopped')),
  -- The owner's cap on what one bot may commit, a decimal string in cap_asset.
  cap text NOT NULL CONSTRAINT signal_bots_cap_ck CHECK (cap ~ '^[0-9]+(\.[0-9]+)?$'),
  cap_asset text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS signal_bots_request_idx ON trade.signal_bots (user_id, client_bot_id);
CREATE INDEX IF NOT EXISTS signal_bots_user_idx ON trade.signal_bots (user_id, created_at DESC);
