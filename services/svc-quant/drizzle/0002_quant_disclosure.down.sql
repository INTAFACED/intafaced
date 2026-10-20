-- intafaced:destructive — reversal of 0002_quant_disclosure.sql
--
-- Drops the disclosure versions and acceptances. Nothing here was a ledger post.

DROP TABLE IF EXISTS "quant"."disclosure_acceptances";
DROP TABLE IF EXISTS "quant"."disclosure_versions";
DROP FUNCTION IF EXISTS "quant"."reject_disclosure_rewrite"();
