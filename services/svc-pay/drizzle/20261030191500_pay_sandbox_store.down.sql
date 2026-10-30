-- intafaced:destructive — reversal of 20261030191500_pay_sandbox_store.sql
--
-- Drops the developer sandbox store. Only TEST balances are lost; no ledger row, payment or real balance changes,
-- because nothing in this schema was ever posted anywhere.

DROP TABLE IF EXISTS "pay_sandbox"."events";
DROP TABLE IF EXISTS "pay_sandbox"."balances";
DROP SCHEMA IF EXISTS "pay_sandbox";
