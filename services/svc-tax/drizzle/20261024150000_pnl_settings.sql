-- Profit and loss settings for the indicator (J-portfolio-05 step 2): whether transfers count.
-- Reversal: 20261024150000_pnl_settings.down.sql
--
-- The tax schema is created by the database bootstrap. This role does not create schemas.
-- One row per customer who chose: whether deposits, transfers in and withdrawals count in their profit and loss. No row:
-- not chosen, and they count. Settings only: no balance, no amount. Idempotent, so the file is re-runnable.

CREATE TABLE IF NOT EXISTS tax.pnl_settings (
  user_id text NOT NULL,
  include_transfers boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pnl_settings_pk PRIMARY KEY (user_id)
);
