DROP TRIGGER IF EXISTS "result_shares_revoke_only" ON "quant"."result_shares";
DROP FUNCTION IF EXISTS "quant"."reject_share_rewrite"();
DROP TABLE IF EXISTS "quant"."share_reads";
DROP TABLE IF EXISTS "quant"."result_shares";
