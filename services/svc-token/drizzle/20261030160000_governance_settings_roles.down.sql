ALTER TABLE "token"."proposals" DROP COLUMN IF EXISTS "cancelled_at";
ALTER TABLE "token"."proposals" DROP COLUMN IF EXISTS "cancelled_by";
ALTER TABLE "token"."proposals" DROP COLUMN IF EXISTS "cancel_reason";
DROP TABLE IF EXISTS "token"."governance_role_moves";
DROP TABLE IF EXISTS "token"."governance_roles";
DROP TABLE IF EXISTS "token"."governance_settings_moves";
DROP TABLE IF EXISTS "token"."governance_settings";
