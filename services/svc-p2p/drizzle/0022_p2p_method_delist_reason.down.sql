-- Reverses 0022_p2p_method_delist_reason.sql.
ALTER TABLE "p2p"."payment_method_schemas" DROP CONSTRAINT IF EXISTS "payment_method_schemas_delist_reason_ck";
ALTER TABLE "p2p"."payment_method_schemas" DROP COLUMN IF EXISTS "delisted_at";
ALTER TABLE "p2p"."payment_method_schemas" DROP COLUMN IF EXISTS "delist_reason";
