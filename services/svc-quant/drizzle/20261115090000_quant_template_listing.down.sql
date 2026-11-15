-- intafaced:destructive — reversal of 20261115090000_quant_template_listing.sql
--
-- Drops the withdraw and restore rows: every starter template is listed again. No template version, strategy or run is
-- touched.
DROP TABLE IF EXISTS "quant"."template_listing";
DROP FUNCTION IF EXISTS "quant"."reject_template_listing_rewrite"();
