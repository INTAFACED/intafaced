-- intafaced:destructive — reversal of 0134_pay_merchant_terms_acceptances.sql
--
-- Drops the record of which terms versions each business accepted.

DROP TRIGGER IF EXISTS "merchant_terms_acceptances_append_only_trg" ON "pay"."merchant_terms_acceptances";
DROP FUNCTION IF EXISTS "pay"."merchant_terms_acceptances_append_only"();
DROP TABLE IF EXISTS "pay"."merchant_terms_acceptances";
