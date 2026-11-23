-- Reverses 20261112112346_user_venue_agent_account_limits.sql.
ALTER TABLE trade.user_venue_agent_accounts
  DROP COLUMN IF EXISTS max_daily_loss,
  DROP COLUMN IF EXISTS max_leverage,
  DROP COLUMN IF EXISTS max_order_notional;
