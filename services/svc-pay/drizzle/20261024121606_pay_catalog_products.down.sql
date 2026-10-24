-- intafaced:destructive — reversal of 20261024121606_pay_catalog_products.sql
--
-- Drops every business's products and product images.

DROP TRIGGER IF EXISTS "catalog_products_versioned_trg" ON "pay"."catalog_products";
DROP FUNCTION IF EXISTS "pay"."catalog_products_versioned"();
DROP TRIGGER IF EXISTS "catalog_product_images_kept_trg" ON "pay"."catalog_product_images";
DROP FUNCTION IF EXISTS "pay"."catalog_product_images_kept"();
DROP TABLE IF EXISTS "pay"."catalog_products";
DROP TABLE IF EXISTS "pay"."catalog_product_images";
