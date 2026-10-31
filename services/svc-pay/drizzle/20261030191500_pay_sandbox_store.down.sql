-- intafaced:destructive — reversal of 20261030191500_pay_sandbox_store.sql
--
-- Drops the developer sandbox store. Only TEST balances are lost; no ledger row, payment or real balance changes,
-- because nothing in these tables was ever posted anywhere.

DROP TABLE IF EXISTS "pay"."sandbox_events";
DROP TABLE IF EXISTS "pay"."sandbox_balances";
