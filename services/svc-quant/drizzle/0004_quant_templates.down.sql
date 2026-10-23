-- intafaced:destructive — reversal of 0004_quant_templates.sql
--
-- Drops the starter templates and their append-only function. Strategies made from a template keep their own rules;
-- nothing in them points here. Nothing here was a ledger post.

DROP TABLE IF EXISTS "quant"."templates";
DROP FUNCTION IF EXISTS "quant"."reject_template_rewrite"();
