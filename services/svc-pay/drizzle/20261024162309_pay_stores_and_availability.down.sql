-- intafaced:destructive — reversal of 20261024162309_pay_stores_and_availability.sql
--
-- Drops every business's stores and where its products are not sold: every product is sold everywhere again.

DROP TABLE IF EXISTS "pay"."catalog_product_unavailable";
DROP TRIGGER IF EXISTS "stores_kept_trg" ON "pay"."stores";
DROP FUNCTION IF EXISTS "pay"."stores_kept"();
DROP TRIGGER IF EXISTS "stores_fixed_trg" ON "pay"."stores";
DROP FUNCTION IF EXISTS "pay"."stores_fixed"();
DROP TABLE IF EXISTS "pay"."stores";
