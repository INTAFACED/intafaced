-- intafaced:destructive — reversal of 20261024160000_pay_catalog_product_imports.sql
--
-- Forgets which files were imported. The products stay, and so do their create keys, so importing one of those files
-- again is refused (`pay.request_id_reused`) rather than making its products twice.

DROP TABLE IF EXISTS "pay"."catalog_product_imports";
DROP FUNCTION IF EXISTS "pay"."catalog_product_imports_kept"();
