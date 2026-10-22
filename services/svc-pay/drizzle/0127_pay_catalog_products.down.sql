-- intafaced:destructive — reversal of 0127_pay_catalog_products.sql
--
-- Drops merchant product records and their request log. No money or price lives here.
DROP TABLE IF EXISTS "pay"."catalog_product_actions";
DROP TRIGGER IF EXISTS "catalog_products_ref_immutable_trg" ON "pay"."catalog_products";
DROP FUNCTION IF EXISTS "pay"."catalog_products_ref_immutable"();
DROP TABLE IF EXISTS "pay"."catalog_products";
