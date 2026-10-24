-- intafaced:destructive — reversal of 20261024132500_pay_catalog_prices.sql
--
-- Drops every business's product prices.

DROP TRIGGER IF EXISTS "catalog_prices_fixed_trg" ON "pay"."catalog_prices";
DROP FUNCTION IF EXISTS "pay"."catalog_prices_fixed"();
DROP TABLE IF EXISTS "pay"."catalog_prices";
