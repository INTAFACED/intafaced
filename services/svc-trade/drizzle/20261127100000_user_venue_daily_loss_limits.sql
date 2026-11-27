-- trade.user_venue_daily_loss_limits · the person's opt-in daily loss limit on their own venue account
-- (src/venue/daily-loss-limit.ts). Reversal: 20261127100000_user_venue_daily_loss_limits.down.sql
--
-- A setting, never a balance: nothing is sent to the venue and the ledger posts nothing. When the account's realised
-- loss since 00:00 UTC (read from the venue's own fills) reaches `limit_amount`, a new opening order warns (advisory) or
-- is refused (blocking); a reduce-only exit is never blocked. A stricter change replaces the active terms at once; a
-- looser one is held in the pending columns until `pending_effective_at`, 24 hours after it was asked.

CREATE TABLE IF NOT EXISTS trade.user_venue_daily_loss_limits (
  user_id text NOT NULL CONSTRAINT user_venue_daily_loss_limits_user_ck CHECK (length(btrim(user_id)) > 0),
  venue_id text NOT NULL,
  owner text NOT NULL CONSTRAINT user_venue_daily_loss_limits_owner_ck CHECK (owner ~ '^0x[0-9a-f]{40}$'),
  -- The asset the loss and the limit are counted in (the venue's perpetuals collateral).
  asset text NOT NULL CONSTRAINT user_venue_daily_loss_limits_asset_ck CHECK (length(btrim(asset)) > 0),
  -- The terms in force: both NULL while the limit is off.
  mode text CONSTRAINT user_venue_daily_loss_limits_mode_ck CHECK (mode IS NULL OR mode IN ('advisory', 'blocking')),
  limit_amount numeric(78, 18) CONSTRAINT user_venue_daily_loss_limits_limit_ck CHECK (limit_amount IS NULL OR limit_amount > 0),
  -- A loosening waiting out its 24 hours: `pending` true with both terms NULL is turning the limit off.
  pending boolean NOT NULL DEFAULT false,
  pending_mode text CONSTRAINT user_venue_daily_loss_limits_pending_mode_ck CHECK (pending_mode IS NULL OR pending_mode IN ('advisory', 'blocking')),
  pending_limit numeric(78, 18) CONSTRAINT user_venue_daily_loss_limits_pending_limit_ck CHECK (pending_limit IS NULL OR pending_limit > 0),
  pending_effective_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, venue_id, owner),
  CONSTRAINT user_venue_daily_loss_limits_terms_ck CHECK ((mode IS NULL) = (limit_amount IS NULL)),
  CONSTRAINT user_venue_daily_loss_limits_pending_terms_ck CHECK ((pending_mode IS NULL) = (pending_limit IS NULL)),
  CONSTRAINT user_venue_daily_loss_limits_pending_ck CHECK (
    (pending AND pending_effective_at IS NOT NULL) OR (NOT pending AND pending_mode IS NULL AND pending_effective_at IS NULL)
  )
);
