-- trade.user_venue_daily_loss_warnings · an opening order the person prepared while their advisory daily loss limit
-- stood reached, with the warning they were given on it (src/venue/daily-loss-limit.ts `DailyLossGuard.admit`).
-- Reversal: 20261128100000_user_venue_daily_loss_warnings.down.sql
--
-- A record of a warning, never a balance: nothing is sent to the venue and the ledger posts nothing. The trade journal's
-- "keeping my rules" line leaves out a trade whose opening fill carries one of these client order ids (J-portfolio-19
-- #4). A warned order that was never sent has no fill, so its row changes nothing.

CREATE TABLE IF NOT EXISTS trade.user_venue_daily_loss_warnings (
  user_id text NOT NULL CONSTRAINT user_venue_daily_loss_warnings_user_ck CHECK (length(btrim(user_id)) > 0),
  venue_id text NOT NULL,
  owner text NOT NULL CONSTRAINT user_venue_daily_loss_warnings_owner_ck CHECK (owner ~ '^0x[0-9a-f]{40}$'),
  venue_client_order_id text NOT NULL CONSTRAINT user_venue_daily_loss_warnings_cloid_ck CHECK (venue_client_order_id ~ '^0x[0-9a-f]{32}$'),
  asset text NOT NULL CONSTRAINT user_venue_daily_loss_warnings_asset_ck CHECK (length(btrim(asset)) > 0),
  limit_amount numeric(78, 18) NOT NULL CONSTRAINT user_venue_daily_loss_warnings_limit_ck CHECK (limit_amount > 0),
  loss_amount numeric(78, 18) NOT NULL CONSTRAINT user_venue_daily_loss_warnings_loss_ck CHECK (loss_amount >= 0),
  warned_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, venue_id, owner, venue_client_order_id)
);
