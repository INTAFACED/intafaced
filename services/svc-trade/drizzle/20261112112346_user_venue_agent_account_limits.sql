-- trade.user_venue_agent_accounts · the person's own per-order, leverage and daily-loss caps on an agent account
-- (J-agents-21 #16 #17; src/venue/agent-account.ts). Reversal: 20261112112346_user_venue_agent_account_limits.down.sql
--
-- Limits, never money: each is set by the person under the owner's ceiling for it, and blank (NULL) means not set, when
-- only the owner's own bounds hold. Amounts are canonical decimal strings in the account's asset; leverage is whole times.

ALTER TABLE trade.user_venue_agent_accounts
  ADD COLUMN IF NOT EXISTS max_order_notional text
    CONSTRAINT user_venue_agent_accounts_max_order_ck CHECK (max_order_notional ~ '^[0-9]+(\.[0-9]+)?$' AND max_order_notional !~ '^0+(\.0+)?$'),
  ADD COLUMN IF NOT EXISTS max_leverage integer
    CONSTRAINT user_venue_agent_accounts_max_leverage_ck CHECK (max_leverage >= 1),
  ADD COLUMN IF NOT EXISTS max_daily_loss text
    CONSTRAINT user_venue_agent_accounts_max_daily_loss_ck CHECK (max_daily_loss ~ '^[0-9]+(\.[0-9]+)?$' AND max_daily_loss !~ '^0+(\.0+)?$');
