-- intafaced:destructive — reversal of 20261024150000_pnl_settings.sql
--
-- Drops the customers' saved profit and loss settings (whether transfers count). They are settings, not money: the lot
-- book falls back to the product default (transfers count). The tax schema is left in place; the bootstrap owns it.

DROP TABLE IF EXISTS tax.pnl_settings;
