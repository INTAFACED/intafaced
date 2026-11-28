-- trade.user_venue_profit_lock* · the person's weekly Profit lock on their own venue account (J-wallet-26;
-- src/venue/profit-lock.ts). Reversal: 20261127214036_user_venue_profit_locks.down.sql
--
-- A setting and a list of offers, never a balance: nothing is sent to the venue from here and the ledger posts nothing.
-- The person sets a weekly target for the account's realised profit, as the venue reports it on its own fills, a share
-- of it to lock (percent) and their own cold wallet's address. The week runs from `week_from` (00:00 UTC Monday) for
-- seven days. When the week's realised profit reaches the target, one offer row is written under its business key
-- `profit-lock:<user>:<venue>:<owner>:<week_from>` (unique), and published after; the consumer files the one message
-- under that key, so a crash between the two publishes it again and the person still gets one message for the week.
-- The withdrawal itself is the person's own signed venue action through the venue door, keyed by `withdrawal_key`.
--
-- `test_aged_at`: the last time the TEST clock (svc-trade's TEST age door, subject `profit-lock`) moved this lock's week
-- back; venue fills before it belong to the week that ended, so the next week starts no earlier. NULL outside TEST.

CREATE TABLE IF NOT EXISTS trade.user_venue_profit_locks (
  id uuid PRIMARY KEY,
  user_id text NOT NULL CONSTRAINT user_venue_profit_locks_user_ck CHECK (length(btrim(user_id)) > 0),
  venue_id text NOT NULL,
  owner text NOT NULL CONSTRAINT user_venue_profit_locks_owner_ck CHECK (owner ~ '^0x[0-9a-f]{40}$'),
  asset text NOT NULL CONSTRAINT user_venue_profit_locks_asset_ck CHECK (length(btrim(asset)) > 0),
  target numeric(78, 18) NOT NULL CONSTRAINT user_venue_profit_locks_target_ck CHECK (target > 0),
  share_percent numeric(78, 18) NOT NULL CONSTRAINT user_venue_profit_locks_share_ck CHECK (share_percent > 0 AND share_percent <= 100),
  cold_wallet text NOT NULL CONSTRAINT user_venue_profit_locks_cold_ck CHECK (cold_wallet ~ '^0x[0-9a-f]{40}$'),
  week_from timestamptz NOT NULL,
  test_aged_at timestamptz,
  last_read_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS user_venue_profit_locks_account_uq ON trade.user_venue_profit_locks (user_id, venue_id, owner);

CREATE TABLE IF NOT EXISTS trade.user_venue_profit_lock_offers (
  offer_key text PRIMARY KEY,
  lock_id uuid NOT NULL REFERENCES trade.user_venue_profit_locks (id),
  user_id text NOT NULL,
  week_from timestamptz NOT NULL,
  asset text NOT NULL,
  -- The week's realised profit as the venue reported it at the crossing, and the terms in force then.
  profit numeric(78, 18) NOT NULL,
  target numeric(78, 18) NOT NULL,
  share_percent numeric(78, 18) NOT NULL,
  amount numeric(78, 18) NOT NULL CONSTRAINT user_venue_profit_lock_offers_amount_ck CHECK (amount > 0),
  cold_wallet text NOT NULL,
  withdrawal_key text NOT NULL,
  -- `ready` until the person closes it (`declined`); a signed withdrawal is read from the door's own record by its key.
  state text NOT NULL CONSTRAINT user_venue_profit_lock_offers_state_ck CHECK (state IN ('ready', 'declined')),
  created_at timestamptz NOT NULL,
  published_at timestamptz,
  declined_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS user_venue_profit_lock_offers_week_uq ON trade.user_venue_profit_lock_offers (lock_id, week_from);
CREATE INDEX IF NOT EXISTS user_venue_profit_lock_offers_unpublished_idx
  ON trade.user_venue_profit_lock_offers (created_at) WHERE published_at IS NULL;
