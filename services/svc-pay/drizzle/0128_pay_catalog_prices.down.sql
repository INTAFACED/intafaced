-- intafaced:destructive — reversal of 0128_pay_catalog_prices.sql
--
-- Drops price records, the default-price pointer and the request log. Invoices and links copy their amounts at issue,
-- so nothing already issued reads these rows.
DROP TABLE IF EXISTS "pay"."catalog_price_actions";
ALTER TABLE "pay"."catalog_products" DROP COLUMN IF EXISTS "default_price_id";
DROP TRIGGER IF EXISTS "catalog_prices_immutable_trg" ON "pay"."catalog_prices";
DROP FUNCTION IF EXISTS "pay"."catalog_prices_immutable"();
DROP TABLE IF EXISTS "pay"."catalog_prices";
