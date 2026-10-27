-- intafaced:destructive — reversal of 20261024084448_pay_business_categories.sql
--
-- Drops the business category table, its history, and every business's chosen category.

DROP TRIGGER IF EXISTS "business_categories_versioned_trg" ON "pay"."business_categories";
DROP FUNCTION IF EXISTS "pay"."business_categories_versioned"();
DROP TRIGGER IF EXISTS "merchant_category_events_append_only_trg" ON "pay"."merchant_category_events";
DROP TRIGGER IF EXISTS "business_category_events_append_only_trg" ON "pay"."business_category_events";
DROP FUNCTION IF EXISTS "pay"."business_category_append_only"();
DROP TABLE IF EXISTS "pay"."merchant_category_events";
DROP TABLE IF EXISTS "pay"."merchant_categories";
DROP TABLE IF EXISTS "pay"."business_category_events";
DROP TABLE IF EXISTS "pay"."business_categories";
