-- trade.user_venue_balance_watch_* · what the venue balance watch has already told the private balances stream about a
-- person's own venue account (J-cex-spot-15 #9; src/venue/balance-watch.ts). Reversal:
-- 20261123170910_user_venue_balance_watch.down.sql
--
-- The venue holds the balance and is its record; nothing here is a balance of ours and the ledger posts nothing. These
-- rows are the watch's cursor: the venue's totals it last reported per asset, the venue records (a deposit's reference,
-- a fill's trade id) whose change it has already published, and from when it reads the account's fills. A watch that
-- stops after publishing and before writing here publishes the same changes again under the same ids, and the stream
-- ignores a repeated id.

CREATE TABLE IF NOT EXISTS trade.user_venue_balance_watch_accounts (
  venue_id text NOT NULL,
  owner text NOT NULL CONSTRAINT user_venue_balance_watch_accounts_owner_ck CHECK (owner ~ '^0x[0-9a-f]{40}$'),
  -- '' is the owner's main account.
  sub_account text NOT NULL,
  fills_since timestamptz NOT NULL,
  PRIMARY KEY (venue_id, owner, sub_account)
);

CREATE TABLE IF NOT EXISTS trade.user_venue_balance_watch_totals (
  venue_id text NOT NULL,
  owner text NOT NULL,
  sub_account text NOT NULL,
  asset text NOT NULL,
  total numeric(78, 18) NOT NULL CONSTRAINT user_venue_balance_watch_totals_total_ck CHECK (total >= 0),
  -- How many changes of this asset the venue reported no record for: the id of the next one.
  unreported integer NOT NULL DEFAULT 0 CONSTRAINT user_venue_balance_watch_totals_unreported_ck CHECK (unreported >= 0),
  PRIMARY KEY (venue_id, owner, sub_account, asset),
  FOREIGN KEY (venue_id, owner, sub_account) REFERENCES trade.user_venue_balance_watch_accounts (venue_id, owner, sub_account)
);

CREATE TABLE IF NOT EXISTS trade.user_venue_balance_watch_seen (
  venue_id text NOT NULL,
  owner text NOT NULL,
  sub_account text NOT NULL,
  record_id text NOT NULL,
  PRIMARY KEY (venue_id, owner, sub_account, record_id),
  FOREIGN KEY (venue_id, owner, sub_account) REFERENCES trade.user_venue_balance_watch_accounts (venue_id, owner, sub_account)
);
