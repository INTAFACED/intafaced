-- trade.user_venue_margin_topup_permissions, trade.user_venue_margin_topup_rules, trade.user_venue_margin_topups · the auto
-- top-up of an isolated position's margin on the person's own venue account (J-derivatives-06 #4;
-- src/venue/margin-topup.ts). Reversal: 20261123023000_user_venue_margin_topups.down.sql
--
-- Nothing here is a balance and nothing is posted: the venue holds the position and its margin, and a top-up moves the
-- person's own free collateral into their own position's margin there. A permission row holds the cap the person gave the
-- margin top-up agent key their wallet approves on the venue (the permission's own cap) and what was sent under it; a rule
-- row holds one position's level, amount and cap and what was sent under it; a top-up row names one venue margin change
-- by its business key (`margin:<owner>:<symbol>:add:auto.<n>`), written before the key signs it. `added` counts a top-up
-- from the moment it is claimed until the venue definitely refuses it, so it can only refuse more than the venue applied.

CREATE TABLE IF NOT EXISTS trade.user_venue_margin_topup_permissions (
  user_id       text NOT NULL CONSTRAINT user_venue_margin_topup_permissions_user_ck CHECK (length(btrim(user_id)) > 0),
  venue_id      text NOT NULL,
  owner         text NOT NULL CONSTRAINT user_venue_margin_topup_permissions_owner_ck CHECK (owner ~ '^0x[0-9a-f]{40}$'),
  agent_address text NOT NULL CONSTRAINT user_venue_margin_topup_permissions_agent_ck CHECK (agent_address ~ '^0x[0-9a-f]{40}$'),
  cap           numeric(38, 18) NOT NULL,
  added         numeric(38, 18) NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  PRIMARY KEY (user_id, venue_id, owner),
  CONSTRAINT user_venue_margin_topup_permissions_cap_ck CHECK (cap > 0),
  -- The invariant: what was sent under the permission never passes the permission's own cap.
  CONSTRAINT user_venue_margin_topup_permissions_added_ck CHECK (added >= 0 AND added <= cap)
);

CREATE TABLE IF NOT EXISTS trade.user_venue_margin_topup_rules (
  user_id    text NOT NULL,
  venue_id   text NOT NULL,
  owner      text NOT NULL,
  symbol     text NOT NULL CONSTRAINT user_venue_margin_topup_rules_symbol_ck CHECK (length(btrim(symbol)) > 0),
  is_on      boolean NOT NULL,
  level      numeric(38, 18) NOT NULL,
  amount     numeric(38, 18) NOT NULL,
  cap        numeric(38, 18) NOT NULL,
  added      numeric(38, 18) NOT NULL DEFAULT 0,
  armed      boolean NOT NULL,
  stopped    text,
  n          integer NOT NULL DEFAULT 0,
  sending    integer,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, venue_id, owner, symbol),
  CONSTRAINT user_venue_margin_topup_rules_permission_fk FOREIGN KEY (user_id, venue_id, owner)
    REFERENCES trade.user_venue_margin_topup_permissions (user_id, venue_id, owner),
  CONSTRAINT user_venue_margin_topup_rules_level_ck CHECK (level > 0),
  CONSTRAINT user_venue_margin_topup_rules_amount_ck CHECK (amount > 0 AND amount <= cap),
  -- The invariant: what was sent under the rule never passes its cap.
  CONSTRAINT user_venue_margin_topup_rules_added_ck CHECK (added >= 0 AND added <= cap),
  CONSTRAINT user_venue_margin_topup_rules_stopped_ck CHECK (stopped IS NULL OR stopped IN ('cap', 'permission_cap')),
  CONSTRAINT user_venue_margin_topup_rules_sending_ck CHECK (n >= 0 AND (sending IS NULL OR sending = n))
);

CREATE INDEX IF NOT EXISTS user_venue_margin_topup_rules_on_idx ON trade.user_venue_margin_topup_rules (user_id) WHERE is_on;

CREATE TABLE IF NOT EXISTS trade.user_venue_margin_topups (
  user_id    text NOT NULL,
  venue_id   text NOT NULL,
  owner      text NOT NULL,
  symbol     text NOT NULL,
  n          integer NOT NULL CONSTRAINT user_venue_margin_topups_n_ck CHECK (n > 0),
  change_key text NOT NULL CONSTRAINT user_venue_margin_topups_key_ck CHECK (change_key LIKE 'margin:' || owner || ':%:add:auto.' || n),
  amount     numeric(38, 18) NOT NULL CONSTRAINT user_venue_margin_topups_amount_ck CHECK (amount > 0),
  level_seen numeric(38, 18) NOT NULL,
  state      text NOT NULL CONSTRAINT user_venue_margin_topups_state_ck CHECK (state IN ('sending', 'added', 'refused')),
  failure    text,
  created_at timestamptz NOT NULL,
  settled_at timestamptz,
  PRIMARY KEY (user_id, venue_id, owner, symbol, n),
  CONSTRAINT user_venue_margin_topups_rule_fk FOREIGN KEY (user_id, venue_id, owner, symbol)
    REFERENCES trade.user_venue_margin_topup_rules (user_id, venue_id, owner, symbol)
);
