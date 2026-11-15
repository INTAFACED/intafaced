-- Reverses the strategy teams migration (J-algo-dev-08). Every collaborator, edit lock, support grant and support read row is lost.
DROP TRIGGER IF EXISTS "support_reads_insert_only" ON "quant"."support_reads";
DROP TRIGGER IF EXISTS "support_grants_insert_only" ON "quant"."support_grants";
DROP FUNCTION IF EXISTS "quant"."reject_support_rewrite"();
DROP TABLE IF EXISTS "quant"."support_reads";
DROP TABLE IF EXISTS "quant"."support_grants";
DROP TABLE IF EXISTS "quant"."strategy_edit_locks";
DROP TABLE IF EXISTS "quant"."strategy_collaborators";
